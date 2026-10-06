import { app, BrowserWindow, dialog, shell, nativeImage } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { getApiUrls } from './config/environment';
import { BUILD_ENV } from './config/build-env';
import { peekAnonymousId } from './anonymous-id';

// Check if we're in development mode
const args = process.argv.slice(1);
const serve = args.some(val => val === '--serve');

// Get the main window reference
let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/**
 * Safe send to renderer — guards against destroyed window.
 * Fixes "Object has been destroyed" crash when app quits during async operations.
 */
function sendToRenderer(channel: string, data?: any): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// Update check state
let isCheckingForUpdates = false;
let isDownloading = false;
let lastUpdateCheck: Date | null = null;
let downloadProgress = 0;

// Auto-update settings
let autoDownloadEnabled = true;
let autoInstallEnabled = true;

// Interfaces
/**
 * The shape the backend actually sends, field for field.
 *
 * This used to be an invented shape: `checksum`, `releaseNotes`, `isMandatory` and
 * `updateAvailable` are not names the backend ever serialises, so every one of them
 * read as `undefined` on every update check. It went unnoticed because each had a
 * harmless-looking fallback -- the version comparison below covered `updateAvailable`,
 * a default string covered the release notes, and the checksum verification was
 * conditional and therefore skipped entirely.
 *
 * The checksum being mandatory now removes the last of those cushions, so the names
 * have to match LauncherVersionDTO.java exactly. They are Lombok getters serialised
 * by Jackson: `Boolean mandatory` -> `mandatory`, `Boolean isNewerThanCurrent` ->
 * `isNewerThanCurrent`. Do not "tidy" these into nicer names without changing the
 * Java DTO with them.
 */
interface LauncherVersionDTO {
  id: number;
  version: string;
  platform: string;
  downloadUrl: string;
  /** The Java field is `changelog`; there is no `releaseNotes` on the response. */
  changelog: string;
  releaseDate: string;
  fileSize: number;
  /** SHA-256, hex. See calculateChecksum() for why it is not SHA-512. */
  fileChecksum: string;
  mandatory: boolean;
  /** Set by the /compare/{version} endpoint only. */
  isNewerThanCurrent?: boolean;
}

interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  isMandatory?: boolean;
  fileSize?: number;
  checksum?: string;
  error?: string;
}

/**
 * Get the current app version from package.json
 */
export function getCurrentVersion(): string {
  return app.getVersion();
}

/**
 * Make an HTTP/HTTPS request to the API
 */
function makeRequest(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          makeRequest(redirectUrl).then(resolve).catch(reject);
          return;
        }
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      
      response.on('end', () => {
        resolve(data);
      });
    });
    
    request.on('error', (error) => {
      reject(error);
    });
    
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Check for updates from the backend API
 */
/**
 * A staging build never updates itself. Its version comes from the newest tag on dev,
 * which trails master, while staging's database is a copy of production's and lists
 * the production releases. Every staging build therefore looked out of date, and the
 * auto-update replaced it with the production binary on its first launch.
 */
const UPDATES_DISABLED_REASON = BUILD_ENV === 'production' ? null : 'Updates are disabled in staging builds';

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (UPDATES_DISABLED_REASON) {
    console.log(`🔄 ${UPDATES_DISABLED_REASON}`);
    return { updateAvailable: false, currentVersion: getCurrentVersion(), error: UPDATES_DISABLED_REASON };
  }

  if (isCheckingForUpdates) {
    return {
      updateAvailable: false,
      currentVersion: getCurrentVersion(),
      error: 'Update check already in progress'
    };
  }
  
  isCheckingForUpdates = true;
  const currentVersion = getCurrentVersion();
  
  console.log(`🔄 Checking for updates... Current version: ${currentVersion}`);
  
  try {
    const apiUrls = getApiUrls();
    // Detect platform dynamically so Linux/mac builds request the correct artifact
    const platform = process.platform === 'win32'
      ? 'windows'
      : process.platform === 'linux'
        ? 'linux'
        : 'mac';
    // The id goes with the request because this is the only call every launcher makes
    // on every start. Activity was previously recorded from the server list alone, so a
    // user who opened the launcher and joined a favourite without browsing counted as
    // nobody, and the platform breakdown had no platform to record. The backend tracks
    // activity only when this parameter is present.
    //
    // Peek, never create: on the upgrade launch this runs before Angular has handed
    // over the legacy localStorage id, and creating one here would orphan it (see
    // peekAnonymousId). That launch goes out without an id, as every launch did before.
    let anonymousId: string | null = null;
    try {
      anonymousId = peekAnonymousId();
    } catch (error) {
      // A corrupt config must not cost the user their update check.
      console.warn('🔄 Anonymous ID unavailable, checking for updates without it:', error);
    }
    const baseUrl = `${apiUrls.apiUrl}/launcher/latest/${platform}/compare/${currentVersion}`;
    const url = anonymousId
      ? `${baseUrl}?anonymousId=${encodeURIComponent(anonymousId)}`
      : baseUrl;

    // Logged without the query string: the id is anonymous, but it does not belong
    // in a log file users paste into support threads.
    console.log(`🔄 Update check URL: ${baseUrl}`);

    const response = await makeRequest(url);
    const versionInfo: LauncherVersionDTO = JSON.parse(response);
    
    lastUpdateCheck = new Date();
    
    const updateAvailable = versionInfo.isNewerThanCurrent === true ||
                           compareVersions(versionInfo.version, currentVersion) > 0;

    console.log(`🔄 Update check complete: ${updateAvailable ? 'Update available!' : 'Up to date'}`);
    console.log(`🔄 Latest version: ${versionInfo.version}, Current: ${currentVersion}`);

    // Logged because a manifest with no checksum is now a refusal at install time,
    // and finding that out during the download is far too late to diagnose.
    if (updateAvailable && !versionInfo.fileChecksum) {
      console.warn('⚠️ Update manifest carries no fileChecksum; an automatic install will refuse it.');
    }

    return {
      updateAvailable,
      currentVersion,
      latestVersion: versionInfo.version,
      downloadUrl: versionInfo.downloadUrl,
      releaseNotes: versionInfo.changelog,
      isMandatory: versionInfo.mandatory,
      fileSize: versionInfo.fileSize,
      checksum: versionInfo.fileChecksum
    };
    
  } catch (error) {
    console.error('❌ Update check failed:', error);
    return {
      updateAvailable: false,
      currentVersion,
      error: (error as Error).message
    };
  } finally {
    isCheckingForUpdates = false;
  }
}

/**
 * Compare two semantic versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  
  return 0;
}

/**
 * Show update available dialog to user
 */
export async function showUpdateDialog(updateInfo: UpdateCheckResult): Promise<boolean> {
  if (!mainWindow) {
    console.error('❌ Cannot show update dialog: No main window');
    return false;
  }
  
  const releaseNotes = updateInfo.releaseNotes || 'Bug fixes and improvements';
  const fileSize = updateInfo.fileSize ? `(${formatFileSize(updateInfo.fileSize)})` : '';
  
  const message = updateInfo.isMandatory
    ? `A mandatory update is available!\n\nCurrent: ${updateInfo.currentVersion}\nLatest: ${updateInfo.latestVersion}\n\n${releaseNotes}\n\nYou must update to continue using the launcher.`
    : `A new version is available!\n\nCurrent: ${updateInfo.currentVersion}\nLatest: ${updateInfo.latestVersion} ${fileSize}\n\n${releaseNotes}`;
  
  const buttons = updateInfo.isMandatory
    ? ['Download Now', 'Exit']
    : ['Download Now', 'Remind Me Later'];
  
  const dialogOptions = {
    type: 'info' as const,
    title: 'Day(Z) Beans Launcher',
    message: 'Update Available',
    detail: message,
    buttons,
    defaultId: 0,
    cancelId: 1,
    icon: nativeImage.createFromPath(
      serve
        ? path.join(process.cwd(), 'src', 'assets', 'dayz_beans_launcher_256.png')
        : path.join(process.resourcesPath, 'assets', 'dayz_beans_launcher_256.png')
    )
  };
  
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const dialogResponse = await dialog.showMessageBox(mainWindow, dialogOptions) as unknown as { response: number };
  const selectedButton = dialogResponse.response;
  
  if (selectedButton === 0) {
    // User chose to download
    if (updateInfo.downloadUrl) {
      await openDownloadPage(updateInfo.downloadUrl);
    }
    return true;
  } else if (updateInfo.isMandatory) {
    // User chose exit for mandatory update
    app.quit();
  }
  
  return false;
}

/**
 * Open the download page in the default browser
 */
async function openDownloadPage(downloadUrl: string): Promise<void> {
  // Only ever hand http/https to the OS. The URL comes from the backend update
  // manifest; a file:// or other scheme in shell.openExternal could launch a local
  // program instead of the browser.
  let scheme: string;
  try {
    scheme = new URL(downloadUrl).protocol;
  } catch {
    console.error(`🔗 Refusing to open malformed download URL: ${downloadUrl}`);
    return;
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    console.error(`🔗 Refusing to open download URL with unsafe scheme "${scheme}": ${downloadUrl}`);
    return;
  }
  console.log(`🔗 Opening download URL: ${downloadUrl}`);
  await shell.openExternal(downloadUrl);
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Check for updates on app startup (if enabled)
 */
export async function checkForUpdatesOnStartup(enabled: boolean): Promise<void> {
  // Never auto-check/download updates in dev (unpackaged or `--serve`).
  const isDev = !app.isPackaged || process.argv.some(arg => arg === '--serve');
  if (isDev) {
    console.log('🔄 Auto-update skipped in dev mode');
    return;
  }

  if (!enabled) {
    console.log('🔄 Auto-update check disabled');
    return;
  }

  console.log('🔄 Checking for updates on startup...');
  
  // Delay the check slightly to let the app fully initialize
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  try {
    const result = await checkForUpdates();
    
    if (result.updateAvailable && !result.error) {
      console.log('🔄 Update available, auto-download enabled:', autoDownloadEnabled);
      
      if (autoDownloadEnabled && result.downloadUrl) {
        // Auto-download and install
        const success = await downloadAndInstallUpdate(result);
        if (success) {
          console.log('✅ Auto-update initiated');
          // The app will quit and restart automatically
          return;
        } else {
          console.log('❌ Auto-update failed, showing manual dialog');
          await showUpdateDialog(result);
        }
      } else {
        // Manual update - show dialog
        await showUpdateDialog(result);
      }
    } else if (result.error) {
      console.log(`🔄 Update check failed: ${result.error}`);
    } else {
      console.log('🔄 App is up to date');
    }
  } catch (error) {
    console.error('❌ Startup update check failed:', error);
  }
}

/**
 * Get the last update check time
 */
export function getLastUpdateCheck(): Date | null {
  return lastUpdateCheck;
}

/**
 * Check if currently checking for updates
 */
export function isCurrentlyChecking(): boolean {
  return isCheckingForUpdates;
}

/**
 * Check if currently downloading an update
 */
export function isCurrentlyDownloading(): boolean {
  return isDownloading;
}

/**
 * Get current download progress (0-100)
 */
export function getDownloadProgress(): number {
  return downloadProgress;
}

/**
 * Download file from URL with progress tracking
 */
function downloadFile(url: string, destPath: string, onProgress?: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const file = fs.createWriteStream(destPath);
    let downloadedBytes = 0;
    let totalBytes = 0;
    
    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject);
          return;
        }
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      
      response.pipe(file);
      
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0 && onProgress) {
          const progress = Math.round((downloadedBytes / totalBytes) * 100);
          onProgress(progress);
        }
      });
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
      
      file.on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    });
    
    request.on('error', (error) => {
      fs.unlinkSync(destPath);
      reject(error);
    });
    
    request.setTimeout(60000, () => {
      request.destroy();
      fs.unlinkSync(destPath);
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * Calculate the SHA-256 checksum of a file, as lowercase hex.
 *
 * SHA-256 because that is the digest the rest of the release pipeline speaks:
 * SHA256SUMS.txt, the `sha256` fields in latest.json, APP-ASAR-SHA256.txt and the
 * value CI registers with the backend are all SHA-256. This function computed
 * SHA-512, so even a manifest that did carry a checksum could never have matched.
 */
function calculateChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Download and install update automatically
 */
export async function downloadAndInstallUpdate(updateInfo: UpdateCheckResult): Promise<boolean> {
  // The renderer can hand any manifest to this; a staging build still refuses to update
  if (UPDATES_DISABLED_REASON) {
    console.log(`🔄 ${UPDATES_DISABLED_REASON}`);
    return false;
  }

  if (!updateInfo.downloadUrl) {
    console.error('❌ No download URL provided');
    return false;
  }
  
  if (isDownloading) {
    console.log('⏳ Download already in progress');
    return false;
  }
  
  isDownloading = true;
  downloadProgress = 0;
  
  // Notify renderer that download started
  sendToRenderer('update-download-started', {
    version: updateInfo.latestVersion,
    fileSize: updateInfo.fileSize
  });
  
  try {
    // Create temp directory for download
    const tempDir = path.join(app.getPath('temp'), 'dayz-launcher-updates');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Determine file extension based on platform
    const isWindows = process.platform === 'win32';
    const isLinux = process.platform === 'linux';
    const fileExt = isWindows ? '.exe' : (isLinux ? '.AppImage' : '');
    // The version string comes from the backend manifest and is joined onto a path,
    // so it is reduced to the characters a version can legitimately contain rather
    // than trusted. A manifest is not a hostile input today; it is one compromise
    // away from being the most valuable one in the product.
    const safeVersion = (updateInfo.latestVersion || 'unknown').replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 64);
    const fileName = `DayZBeansLauncher-${safeVersion}${fileExt}`;
    const downloadPath = path.join(tempDir, fileName);
    
    console.log(`⬇️ Downloading update from: ${updateInfo.downloadUrl}`);
    console.log(`⬇️ Saving to: ${downloadPath}`);
    
    // Download the file with progress
    await downloadFile(updateInfo.downloadUrl, downloadPath, (progress) => {
      downloadProgress = progress;
      console.log(`⬇️ Download progress: ${progress}%`);
      
      // Notify renderer of progress
      sendToRenderer('update-download-progress', { progress });
    });
    
    console.log('✅ Download complete');

    // Verify the checksum. Mandatory, not conditional.
    //
    // This used to read `if (updateInfo.checksum)`, so a manifest that simply
    // omitted the field meant the downloaded file was executed with no integrity
    // check at all -- and what happens a few lines below is `spawn(installerPath)`
    // on Windows and replacing the running AppImage on Linux. Failing open is the
    // wrong default for the one code path in the launcher that runs a freshly
    // downloaded binary, so a missing checksum is now a refusal.
    if (!updateInfo.checksum) {
      fs.unlinkSync(downloadPath);
      throw new Error('Update manifest carries no checksum; refusing to install an unverified build.');
    }

    console.log('🔐 Verifying checksum...');
    const fileChecksum = await calculateChecksum(downloadPath);

    // Normalised on both sides: the digest is hex, so case and stray whitespace in
    // the manifest are formatting rather than a mismatch. Anything else is.
    if (fileChecksum.trim().toLowerCase() !== updateInfo.checksum.trim().toLowerCase()) {
      fs.unlinkSync(downloadPath);
      throw new Error('Checksum verification failed');
    }
    console.log('✅ Checksum verified');
    
    // Notify renderer that download completed
    sendToRenderer('update-download-complete', {
      version: updateInfo.latestVersion
    });
    
    // Install the update
    await installUpdate(downloadPath, isWindows, isLinux);
    
    return true;
    
  } catch (error) {
    console.error('❌ Download/Install failed:', error);
    
    sendToRenderer('update-download-error', {
      error: (error as Error).message
    });
    
    return false;
  } finally {
    isDownloading = false;
    downloadProgress = 0;
  }
}

/**
 * Install the downloaded update
 */
async function installUpdate(installerPath: string, isWindows: boolean, isLinux: boolean): Promise<void> {
  console.log(`🚀 Installing update from: ${installerPath}`);
  
  if (isWindows) {
    // Windows: Run NSIS installer with /S for silent install
    console.log('🪟 Installing Windows update silently...');
    
    await new Promise<void>((resolve, reject) => {
      const child = spawn(installerPath, ['/S'], {
        detached: true,
        stdio: 'ignore'
      });
      
      child.on('error', (err) => {
        reject(err);
      });
      
      // NSIS installer will handle the installation and restart
      // We exit immediately to allow the installer to replace our files
      setTimeout(() => {
        console.log('✅ Windows installer launched, quitting app...');
        app.quit();
        resolve();
      }, 2000);
    });
    
  } else if (isLinux) {
    // Linux: Replace current AppImage with new one
    console.log('🐧 Installing Linux AppImage update...');
    
    const currentAppImage = process.env['APPIMAGE'];
    if (!currentAppImage) {
      throw new Error('APPIMAGE environment variable not set');
    }

    // Verify the downloaded file exists and is non-empty before overwriting the
    // currently-running binary — a truncated/failed download would otherwise brick the app.
    const srcStat = fs.statSync(installerPath);
    if (!srcStat.isFile() || srcStat.size === 0) {
      throw new Error('Downloaded AppImage is missing or empty');
    }

    // Copy new AppImage to replace current one
    fs.copyFileSync(installerPath, currentAppImage);
    fs.chmodSync(currentAppImage, 0o755);

    // Verify the replacement copied fully (sizes must match) before restarting
    const destStat = fs.statSync(currentAppImage);
    if (destStat.size !== srcStat.size) {
      throw new Error(`AppImage replacement size mismatch (expected ${srcStat.size}, got ${destStat.size})`);
    }

    console.log('✅ AppImage replaced, restarting...');
    
    // Restart the app
    spawn(currentAppImage, [], {
      detached: true,
      stdio: 'ignore'
    });
    
    app.quit();
    
  } else {
    // macOS or other: Open the downloaded file
    console.log('🍎 Opening installer for manual installation...');
    await shell.openPath(installerPath);
    
    // Show notification that manual install is needed
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Downloaded',
        message: 'Update Ready to Install',
        detail: 'The update has been downloaded. Please run the installer to complete the update.',
        buttons: ['OK']
      });
    }
  }
}

/**
 * Auto-download and install update if available (used for silent updates)
 */
export async function autoDownloadAndInstall(updateInfo: UpdateCheckResult): Promise<boolean> {
  if (!updateInfo.updateAvailable || !updateInfo.downloadUrl) {
    return false;
  }
  
  console.log('🔄 Auto-downloading update...');
  
  try {
    const success = await downloadAndInstallUpdate(updateInfo);
    return success;
  } catch (error) {
    console.error('❌ Auto-update failed:', error);
    return false;
  }
}

/**
 * Enable/disable auto-download
 */
export function setAutoDownload(enabled: boolean): void {
  autoDownloadEnabled = enabled;
}

/**
 * Enable/disable auto-install
 */
export function setAutoInstall(enabled: boolean): void {
  autoInstallEnabled = enabled;
}
