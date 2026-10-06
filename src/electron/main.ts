// Test seam for the e2e suite. Inert (and side-effect free) unless DZBL_E2E=1 in an
// unpackaged build. It has to come before sentry: when active it moves userData, and
// sentry opens electron-store on import.
import { e2eHooks } from './e2e-hooks';

// FIRST real import on purpose: this initializes GlitchTip error reporting for the
// main process on load, so a crash anywhere in the rest of this startup sequence
// is still reported. Anything imported above it would be outside that coverage.
import './sentry';

import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, net } from 'electron';
import { isMusicMuted, onMusicMutedChange, setMusicMuted } from './music-mute';
import { SPEAKER_MUTED_PNG, SPEAKER_ON_PNG } from './mute-icons';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';

// When launched from Steam or an AppImage, the stdout/stderr pipe can be closed
// while the app keeps running. A later console.log then fails with EPIPE which,
// as an unhandled stream 'error', escalates to an uncaughtException and shows
// Electron's "A JavaScript error occurred in the main process" dialog. Swallow
// only EPIPE on the std streams so benign logging can't take the app down; any
// other stream error is re-thrown so real problems are still surfaced.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err && err.code === 'EPIPE') return;
    throw err;
  });
}

// Initialize settings store
const store = new Store();

// Steam startup status shared with the renderer (drives the "Steam required" modal).
// 'pending'     - auto-start in progress; renderer should wait, not show the modal yet
// 'ready'       - steamworks initialized (Steam running + connected)
// 'unavailable' - Steam could not be started/initialized; show the modal
type SteamStartupPhase = 'pending' | 'ready' | 'unavailable';
let steamStartupPhase: SteamStartupPhase = 'pending';
function setSteamStartupPhase(phase: SteamStartupPhase): void {
  const changed = steamStartupPhase !== phase;
  steamStartupPhase = phase;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('steam-init-status', { ready: phase === 'ready', phase });
  }

  // Dump the full picture the moment we decide to block the user. This is the one
  // event support reports are about, and it is the only chance to capture the
  // machine's state while the failure is still fresh.
  if (changed && phase === 'unavailable') {
    (async () => {
      try {
        const { collectSteamDiagnostics, formatDiagnosticsReport } = require('./steam-diagnostics');
        const diagnostics = await collectSteamDiagnostics();
        logToFile(`Steam unavailable — diagnostics follow:\n${formatDiagnosticsReport(diagnostics, false)}`);
      } catch (err) {
        logToFile(`Failed to collect Steam diagnostics: ${err}`);
      }
    })();
  }
}

// Import IPC handlers
const { registerIPCHandlers } = require('./ipc-handlers');
// Import Steam service
const { initializeSteam, startSteamClient, waitForSteamAndInitialize, isSteamInitialized } = require('./steam-service');
// Import Update service
import { setMainWindow, checkForUpdates, checkForUpdatesOnStartup, showUpdateDialog, getCurrentVersion } from './update-service';
// Import Protocol handler
import { registerProtocol, setupProtocolHandling, setProtocolMainWindow } from './protocol-handler';
// Import Discord service
import { discordService } from './discord-service';
// Import mod management for background junction pre-warming
import { preWarmJunctions, cleanupOrphanedLinks, sweepModUpdates } from './mod-management';
// Import platform utilities
import { getAppIconName, getTrayIconName, isWindows, logPlatformInfo } from './platform-utils';
// Import app suspension service
import { initSuspensionService } from './app-suspension';
import { initDeepSleep, setAppEntryUrl } from './deep-sleep';
// Shared file logger (userData/app-debug.log)
import { logToFile, logSessionStart, getLogFilePath } from './logger';

import { getEnvironmentConfig } from './config/environment';

// The handful of channels registered directly in main.ts (rather than in
// ipc-handlers.ts, to avoid a circular import) go through the same validated
// registration as everything else — see ./ipc-register.
import { z } from 'zod';
import { handle, NO_ARGS } from './ipc-register';
import { UpdateCheckResultSchema } from './types/ipc-schemas';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isMinimizedToTray = false;
let closeToTrayEnabled = false;
const args = process.argv.slice(1);
const serve = args.some(val => val === '--serve');

// Spotlight API URL.
//
// The production host used to be hardcoded here, so a staging build still called
// production's API for the splash-screen spotlight. Derived from the build's
// environment instead — see config/build-env.ts.
const SPOTLIGHT_API_URL = serve
  ? 'http://localhost:8088/api/public/promotions/spotlight'
  : `${getEnvironmentConfig().apiUrl}/public/promotions/spotlight`;

/**
 * Fetch the current spotlight server for the launcher splash screen.
 * Non-blocking: returns null on any error or timeout.
 */
async function fetchSpotlight(): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await net.fetch(SPOTLIGHT_API_URL, {
      signal: controller.signal as any
    });
    clearTimeout(timeout);

    if (response.status === 204 || !response.ok) {
      return null;
    }

    return await response.json();
  } catch (err) {
    logToFile(`Spotlight fetch failed (non-critical): ${err}`);
    return null;
  }
}

// Window bounds interface for type safety
interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

// Default window bounds
const DEFAULT_BOUNDS: WindowBounds = {
  x: undefined as any,
  y: undefined as any,
  width: 1600,
  height: 900,
  isMaximized: true
};

/**
 * Get saved window bounds from store, with validation
 */
function getSavedWindowBounds(): WindowBounds {
  const saved = store.get('windowBounds') as WindowBounds | undefined;
  
  if (!saved) {
    return DEFAULT_BOUNDS;
  }
  
  // Validate bounds are reasonable
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  
  // Check if saved position is visible on any display
  const isVisible = displays.some((display: Electron.Display) => {
    const { x, y, width, height } = display.bounds;
    return (
      saved.x >= x - 100 && 
      saved.x < x + width &&
      saved.y >= y - 100 && 
      saved.y < y + height
    );
  });
  
  if (!isVisible) {
    logToFile('Saved window position is off-screen, using defaults');
    return DEFAULT_BOUNDS;
  }
  
  return {
    x: saved.x,
    y: saved.y,
    width: Math.max(saved.width || 1600, 1600),
    height: Math.max(saved.height || 900, 900),
    isMaximized: saved.isMaximized ?? true
  };
}

/**
 * Save current window bounds to store
 */
function saveWindowBounds(): void {
  if (!win) return;
  
  const isMaximized = win.isMaximized();
  
  // Only save bounds if not maximized (maximized state is saved separately)
  const bounds = isMaximized ? store.get('windowBounds') as WindowBounds : win.getBounds();
  
  const windowBounds: WindowBounds = {
    x: bounds?.x ?? 0,
    y: bounds?.y ?? 0,
    width: bounds?.width ?? 1600,
    height: bounds?.height ?? 900,
    isMaximized
  };
  
  store.set('windowBounds', windowBounds);
  logToFile(`Window bounds saved: ${JSON.stringify(windowBounds)}`);
}

// Export functions to get main window and tray (needed by IPC handlers)
export function getMainWindow(): BrowserWindow | null {
  return win;
}

export function getTray(): Tray | null {
  return tray;
}

export function setCloseToTray(enabled: boolean): void {
  closeToTrayEnabled = enabled;
  // Persist to store
  store.set('closeToTray', enabled);
}

export function setIsMinimizedToTray(enabled: boolean): void {
  console.log(`🔧 main.ts setIsMinimizedToTray called with: ${enabled}`);
  console.log(`🔧 main.ts Before update: isMinimizedToTray = ${isMinimizedToTray}`);
  isMinimizedToTray = enabled;
  console.log(`🔧 main.ts After update: isMinimizedToTray = ${isMinimizedToTray}`);
  // Persist to store
  store.set('minimizeToTray', enabled);
  console.log(`🔧 main.ts Saved to store: minimizeToTray = ${enabled}`);
}

export function getIsMinimizedToTray(): boolean {
  return isMinimizedToTray;
}

export function getCloseToTray(): boolean {
  return closeToTrayEnabled;
}

// Error logging now lives in ./logger so the Steam and platform layers write to the
// same file. Their bare console.log calls went nowhere in a packaged Windows build,
// which is why "Steam not detected" reports arrived with no cause attached.

function createWindow(): BrowserWindow {
  logToFile('=== Creating Window ===');
  logToFile(`Serve mode: ${serve}`);

  // Get saved window bounds
  const savedBounds = getSavedWindowBounds();
  logToFile(`Restoring window bounds: ${JSON.stringify(savedBounds)}`);

  // Create the browser window with saved bounds
  win = new BrowserWindow({
    x: savedBounds.x,
    y: savedBounds.y,
    width: savedBounds.width,
    height: savedBounds.height,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    icon: serve
      ? path.join(process.cwd(), 'src', 'assets', 'dayz_beans_launcher.ico')
      : path.join(process.resourcesPath, 'assets', 'dayz_beans_launcher.ico'),
    backgroundColor: '#1a1a2e', // Set background color to prevent white flash
    show: false, // Don't show window initially
    webPreferences: {
      // Security: Enable context isolation to prevent renderer from accessing Node.js
      contextIsolation: true,
      // Security: Disable node integration in renderer process
      nodeIntegration: false,
      // Security: Enable web security for all environments
      webSecurity: true,
      // Preload script to expose safe APIs via contextBridge
      preload: path.join(__dirname, 'preload.js'),
      // Security: Disable insecure content even in dev mode
      allowRunningInsecureContent: false,
      // Security: Sandbox the renderer process
      sandbox: true,
      // Never throttle the renderer when backgrounded — Chromium's default
      // background throttling can leave the window blank/frozen when restored
      // to the foreground. CPU is saved by pausing polling on suspend instead
      // (see app-suspension.ts), not by throttling rendering.
      backgroundThrottling: false
    },
  });

  // Taskbar mute button: Windows forgets thumbnail buttons whenever the window hides
  win.on('show', applyThumbarButtons);

  // Open DevTools only in development mode
  if (serve && win) {
    win.webContents.openDevTools();
    
    // Allow keyboard shortcuts to toggle DevTools only in development
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || 
          (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win?.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  // Don't show window until Angular is fully loaded
  let isAppReady = false;
  let isLoadingScreenReady = false;

  // Show window as soon as loading screen is ready (so splash/spotlight is visible)
  let windowShown = false;
  const showWindowWhenReady = () => {
    if (!windowShown && isLoadingScreenReady && win) {
      logToFile('✅ Loading screen ready, showing window with splash');

      // Restore maximized state if it was saved
      if (savedBounds.isMaximized) {
        logToFile('Restoring maximized state');
        win.maximize();
      }

      win.show();
      windowShown = true;
    }
  };
  
  // Save window bounds on move and resize (debounced)
  let boundsTimeout: NodeJS.Timeout | null = null;
  const debouncedSaveBounds = () => {
    if (boundsTimeout) {
      clearTimeout(boundsTimeout);
    }
    boundsTimeout = setTimeout(() => {
      saveWindowBounds();
    }, 500);
  };
  
  if (win) {
    win.on('resize', debouncedSaveBounds);
    win.on('move', debouncedSaveBounds);
    win.on('maximize', () => {
      logToFile('Window maximized');
      saveWindowBounds();
    });
    win.on('unmaximize', () => {
      logToFile('Window unmaximized');
      saveWindowBounds();
    });
  }

  // Show loading screen first
  // In dev, __dirname is dist-electron/electron/ but loading.html is copied to dist-electron/
  const loadingPath = path.join(__dirname, '..', 'loading.html');
  // The splash plays the intro itself, before the renderer and its settings exist, so it
  // gets them in the URL from what the renderer last saved (on by default, at 50%). Off
  // in e2e runs.
  const introOn = !e2eHooks && !isMusicMuted() && store.get('settings.musicIntro', true) !== false;
  const introVolume = Math.min(1, Math.max(0, Number(store.get('settings.musicVolume', 0.5)) || 0));
  const loadingUrl = `file://${path.resolve(loadingPath).replace(/\\/g, '/')}`
    + `?music=${introOn ? 1 : 0}&volume=${introVolume}`;
  logToFile(`Loading splash screen from: ${loadingUrl}`);
  
  if (win) {
    // Splash timing: 8 seconds for spotlight, 5 seconds for default
    let splashMinDisplayMs = e2eHooks?.timing.splashMs ?? 5000;

    // Wait for loading screen to be ready, then try to inject spotlight
    win.webContents.once('did-finish-load', async () => {
      logToFile('Loading screen finished loading');
      isLoadingScreenReady = true;
      showWindowWhenReady();

      // Fetch spotlight data and inject into loading screen (non-blocking)
      try {
        const spotlight = e2eHooks ? null : await fetchSpotlight();
        if (spotlight && spotlight.bannerUrl && win) {
          logToFile(`Spotlight active: ${spotlight.serverName}`);
          splashMinDisplayMs = 6000; // Give spotlight more screen time
          const escaped = JSON.stringify(spotlight);
          win.webContents.executeJavaScript(`window.activateSpotlight(${escaped})`);

          // Store spotlight serverId so Angular can highlight it after load
          store.set('lastSpotlightServerId', spotlight.serverId);
        } else {
          logToFile('No spotlight booking found - showing default splash');
          store.delete('lastSpotlightServerId');
        }
      } catch (err) {
        logToFile(`Spotlight injection skipped: ${err}`);
        store.delete('lastSpotlightServerId');
      }

      // Load Angular after the splash has been visible long enough
      setTimeout(async () => {
        // Check if user clicked "Join" on the splash screen
        try {
          if (win) {
            const joinRequested = await win.webContents.executeJavaScript('window.spotlightJoinRequested');
            if (joinRequested) {
              logToFile('User requested join from splash screen');
              store.set('spotlightJoinRequested', true);
            }
          }
        } catch (_) { /* ignore */ }
        // Loading the app replaces the splash page: fade its intro out first rather than
        // cutting it mid-chord.
        const faded = await win?.webContents.executeJavaScript('window.fadeOutIntro ? window.fadeOutIntro() : 0')
          .catch(() => 0);
        if (faded) await new Promise(resolve => setTimeout(resolve, Number(faded)));
        loadAngularApp();
      }, splashMinDisplayMs);
    });

    win.loadURL(loadingUrl);

    // Extracted Angular loading into a function so splash timing controls it
    const loadAngularApp = () => {
      const currentWindow = win; // Capture current window reference
      if (!currentWindow) {
        logToFile('❌ Window is null, cannot load app');
        return;
      }

      // Wait for Angular app to be fully loaded
      currentWindow.webContents.once('did-finish-load', () => {
        logToFile('Angular app finished loading');
        
        // Wait a bit more for Angular to bootstrap
        setTimeout(() => {
          logToFile('Angular app bootstrap complete');
          
          // Signal to loading screen that app is ready
          currentWindow.webContents.send('app-ready');
          
          // Wait for loading screen to fade out
          setTimeout(() => {
            isAppReady = true;
            showWindowWhenReady();
          }, 600);
        }, 1000);
      });

      if (e2eHooks?.rendererUrl) {
        logToFile(`[e2e] Loading renderer from ${e2eHooks.rendererUrl}`);
        setAppEntryUrl(e2eHooks.rendererUrl);
        currentWindow.loadURL(e2eHooks.rendererUrl);
      } else if (serve) {
        logToFile('Loading dev server: http://localhost:4200');
        setAppEntryUrl('http://localhost:4200');
        currentWindow.loadURL('http://localhost:4200');
      } else {
        // Path when running electron executable
        let pathIndex = './index.html';

        // Check for new build structure (dist-angular/dayz-launcher/browser/index.html)
        if (fs.existsSync(path.join(__dirname, '../../dist-angular/dayz-launcher/browser/index.html'))) {
          pathIndex = '../../dist-angular/dayz-launcher/browser/index.html';
        }
        // Fallback to old structure for backward compatibility
        else if (fs.existsSync(path.join(__dirname, '../../dist/index.html'))) {
          pathIndex = '../../dist/index.html';
        }

        const fullPath = path.join(__dirname, pathIndex);
        const url = `file://${path.resolve(fullPath).replace(/\\/g, '/')}`;
        logToFile(`Loading production app from: ${url}`);
        logToFile(`Full path: ${fullPath}`);
        logToFile(`Path exists: ${fs.existsSync(fullPath)}`);

        setAppEntryUrl(url);
        currentWindow.loadURL(url);
      }
    };
  }

  // Log any errors
  if (win) {
    win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      logToFile(`❌ did-fail-load: ${errorCode} - ${errorDescription}`);
    });

    // Log console errors
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (level >= 2) { // Warning and above
        logToFile(`🔴 Console [${level}]: ${message} (line ${line}, ${sourceId})`);
      }
    });

    // Log uncaught exceptions
    win.webContents.on('render-process-gone', (event, details) => {
      logToFile(`💥 Render process gone: ${details.reason} - ${details.exitCode}`);
    });
  }

  // Emitted when the window is closed
  if (win) {
    win.on('close', (event) => {
      logToFile('Window close event triggered');
      
      // Save window bounds before closing
      saveWindowBounds();
      
      // If close to tray is enabled, prevent closing and hide to tray instead
      if (closeToTrayEnabled && !(app as any).isQuitting) {
        event.preventDefault();
        logToFile('Close to tray enabled, hiding window to tray');
        win!.hide();
        
        // Show tray notification if it doesn't exist
        if (!tray) {
          createTray();
        }
        
        // Show notification that app is in tray
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: 'Day(Z) Beans Launcher',
            body: 'Application minimized to system tray. Click tray icon to restore.',
            silent: true,
            icon: serve
              ? path.join(process.cwd(), 'src', 'assets', 'dayz_beans_launcher_256.png')
              : path.join(process.resourcesPath, 'assets', 'dayz_beans_launcher_256.png')
          });
          notification.show();
        }
        return;
      }
      
      logToFile('Window actually closing');
      if (tray) {
        tray.destroy();
        tray = null;
      }
      win = null;
    });
    
    // Handle window minimize to tray
    win.on('minimize', () => {
      if (isMinimizedToTray) {
        logToFile('Minimize to tray enabled, hiding window');
        win!.hide();
        
        if (!tray) {
          createTray();
        }
      }
    });
    
    // Initialize app suspension service for resource management
    initSuspensionService(win);
    logToFile('✅ App suspension service initialized');

    // Unload the renderer while DayZ runs and the launcher is out of sight
    initDeepSleep(win, () => import('./platform-utils').then(m => m.isDayZRunning()));
  }

  return win;
}

// Create system tray
function createTray(): void {
  try {
    logToFile('Creating system tray');
    console.log('🔧 Creating system tray...');
    
    // Use a simple icon path - fallback to a basic icon if custom one doesn't exist
    let iconPath: string;
    
    if (serve) {
      // Dev mode - check multiple possible locations
      const devPaths = [
        path.join(process.cwd(), 'src', 'assets', 'dayz_beans_launcher.ico'),
        path.join(process.cwd(), 'src', 'assets', 'icon.png'),
        path.join(__dirname, 'assets', 'icon.png')
      ];
      iconPath = devPaths.find(p => fs.existsSync(p)) || devPaths[0];
      console.log('🔍 Dev mode icon paths checked:', devPaths);
    } else {
      // Production mode
      const prodPaths = [
        path.join(process.resourcesPath, 'assets', 'dayz_beans_launcher.ico'),
        path.join(__dirname, 'assets', 'icon.png')
      ];
      iconPath = prodPaths.find(p => fs.existsSync(p)) || prodPaths[0];
      console.log('🔍 Production mode icon paths checked:', prodPaths);
    }
    
    console.log(`🎯 Selected icon path: ${iconPath}`);
    console.log(`📁 File exists: ${fs.existsSync(iconPath)}`);
    
    // Verify icon exists before creating tray
    if (!fs.existsSync(iconPath)) {
      logToFile(`⚠️ Tray icon not found at ${iconPath}, skipping tray creation`);
      console.log(`❌ Tray icon not found at ${iconPath}, skipping tray creation`);
      return;
    }
    
    console.log('🚀 Creating Tray with icon...');
    tray = new Tray(iconPath);
    console.log('✅ Tray object created successfully');
    
    tray.setToolTip('DayZ Beans Launcher');
    tray.setContextMenu(buildTrayMenu());
    
    // Double click to show window
    tray.on('double-click', () => {
      logToFile('Tray: Double clicked');
      showWindow();
    });
    
    logToFile('✅ System tray created successfully');
  } catch (error) {
    logToFile(`❌ Failed to create tray: ${error}`);
  }
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Show DayZ Beans Launcher',
      click: () => {
        logToFile('Tray: Show window clicked');
        showWindow();
      }
    },
    {
      label: 'Mute music',
      type: 'checkbox',
      checked: isMusicMuted(),
      click: item => setMusicMuted(item.checked, 'main')
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        logToFile('Tray: Exit clicked');
        (app as any).isQuitting = true;
        app.quit();
      }
    }
  ]);
}

/**
 * The mute button on the launcher's Windows taskbar thumbnail (hover the taskbar icon).
 * Windows drops thumbnail buttons when the window is hidden, so this is re-applied on
 * every show. No-op elsewhere: macOS and Linux have no thumbnail toolbar.
 */
function applyThumbarButtons(): void {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const muted = isMusicMuted();
  win.setThumbarButtons([{
    tooltip: muted ? 'Unmute music' : 'Mute music',
    icon: nativeImage.createFromDataURL(muted ? SPEAKER_MUTED_PNG : SPEAKER_ON_PNG),
    click: () => setMusicMuted(!isMusicMuted(), 'main')
  }]);
}

// A flip from any side refreshes the taskbar button and tray check; a flip from the
// main process (taskbar, tray) is also pushed to the renderer, which owns the music.
onMusicMutedChange((muted, source) => {
  applyThumbarButtons();
  tray?.setContextMenu(buildTrayMenu());
  if (source === 'main' && win && !win.isDestroyed()) {
    win.webContents.send('music-mute-changed', muted);
  }
});

// Show window from tray
function showWindow(): void {
  if (win) {
    win.show();
    win.focus();
    logToFile('Window shown from tray');
  }
}

// Set app quit flag
(app as any).isQuitting = false;

try {
  logToFile('=== App Starting ===');
  logToFile(`Log file: ${getLogFilePath()}`);
  logToFile(`__dirname: ${__dirname}`);
  logToFile(`Process cwd: ${process.cwd()}`);
  
  // Log platform info for debugging
  logPlatformInfo().catch(err => logToFile(`Failed to log platform info: ${err}`));

  // Set app name and details
  app.name = 'Day(Z) Beans Launcher';
  app.setAppUserModelId('com.dayzlaunch.beans');
  logToFile('App name set to: Day(Z) Beans Launcher');

  // Setup protocol handling (must be done before app.ready)
  logToFile('Setting up dayzbeans:// protocol handling...');
  setupProtocolHandling();

  // Linux + NVIDIA + Wayland: Electron's GPU process crashes importing dmabufs
  // (libEGL / dri2 / "failed to import supplied dmabufs" -> SIGTRAP). Run under
  // XWayland (X11 Ozone) and relax the GPU sandbox — keeps acceleration, avoids the crash.
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    logToFile('Linux GPU workaround applied: ozone-platform-hint=x11, disable-gpu-sandbox');
  }

  // Fix WebGL deprecation warnings (must be before app.ready)
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  logToFile('WebGL flags applied: ignore-gpu-blocklist, enable-unsafe-swiftshader');

  // Note: GPU acceleration disabled is commented out as it conflicts with WebGL flags
  // app.disableHardwareAcceleration();
  // logToFile('GPU hardware acceleration disabled');

  // Added 400 ms to fix the black background issue
  app.on('ready', () => setTimeout(() => {
    try {
      logSessionStart();

      // Initialize Steam first
      logToFile('🎮 Initializing Steam...');
      logToFile(`Working directory: ${process.cwd()}`);
      const steamInitialized = initializeSteam();
      if (steamInitialized) {
        setSteamStartupPhase('ready');
      } else {
        const { getLastSteamInitFailure } = require('./steam-service');
        const failure = getLastSteamInitFailure();
        logToFile(`⚠️ Steam initialization failed at stage '${failure?.stage ?? 'unknown'}': ${failure?.message ?? 'no error recorded'}`);

        // Auto-start Steam if it isn't running, then initialize once it's up.
        // Runs in the background so it never blocks window creation.
        // Skip when Steam integration is disabled (STEAM_ENABLED=false) or the user opted out.
        const steamEnabled = process.env['STEAM_ENABLED'] !== 'false';
        const autoStartSteam = steamEnabled && store.get('settings.autoStartSteam') !== false; // default ON
        if (autoStartSteam) {
          setSteamStartupPhase('pending');
          (async () => {
            try {
              const result = await startSteamClient();
              logToFile(`🚀 Steam auto-start: ${result}`);
              if (result === 'launched' || result === 'running') {
                const ready = await waitForSteamAndInitialize(60000);
                logToFile(ready
                  ? '✅ Steam initialized after auto-start'
                  : '⚠️ Steam still not ready after auto-start wait');
                setSteamStartupPhase(ready ? 'ready' : 'unavailable');
              } else {
                logToFile('⚠️ Steam not installed — cannot auto-start');
                setSteamStartupPhase('unavailable');
              }
            } catch (err) {
              logToFile(`❌ Steam auto-start error: ${err}`);
              setSteamStartupPhase('unavailable');
            }
          })();
        } else {
          // Auto-start disabled and Steam not initialized.
          setSteamStartupPhase('unavailable');
        }
      }
      
      // Register IPC handlers before creating window
      logToFile('Registering IPC handlers...');
      registerIPCHandlers();
      
      // Current Steam startup status (renderer pulls this on init; also pushed via
      // the 'steam-init-status' event when the phase changes).
      handle('get-steam-status', NO_ARGS, () => {
        // Prefer the live client state (covers a successful on-demand ensureSteamInitialized
        // after the user started Steam manually), falling back to the startup phase.
        const ready = isSteamInitialized() || steamStartupPhase === 'ready';
        const phase: SteamStartupPhase = ready ? 'ready' : steamStartupPhase;
        return { ready, phase };
      });

      // Register system integration IPC handlers directly in main.ts to avoid circular dependency
      handle('set-close-to-tray', z.tuple([z.boolean()]), (enabled) => {
        console.log(`🔧 IPC Handler: set-close-to-tray called with enabled: ${enabled}`);
        console.log(`🔧 Before: closeToTrayEnabled = ${closeToTrayEnabled}`);
        closeToTrayEnabled = enabled;
        console.log(`🔧 After: closeToTrayEnabled = ${closeToTrayEnabled}`);
        store.set('closeToTray', enabled);
        logToFile(`Close to tray ${enabled ? 'enabled' : 'disabled'}`);
        return { success: true };
      });

      handle('set-minimize-to-tray', z.tuple([z.boolean()]), (enabled) => {
        console.log(`🔧 IPC Handler: set-minimize-to-tray called with enabled: ${enabled}`);
        console.log(`🔧 Before: isMinimizedToTray = ${isMinimizedToTray}`);
        isMinimizedToTray = enabled;
        console.log(`🔧 After: isMinimizedToTray = ${isMinimizedToTray}`);
        store.set('minimizeToTray', enabled);
        logToFile(`Minimize to tray ${enabled ? 'enabled' : 'disabled'}`);
        return { success: true };
      });

      handle('set-auto-start', z.tuple([z.boolean()]), (enabled) => {
        try {
          app.setLoginItemSettings({
            openAtLogin: enabled,
            path: process.execPath,
            args: process.argv.slice(1).filter(arg => arg !== '--serve')
          });
          logToFile(`Auto start ${enabled ? 'enabled' : 'disabled'}`);
          return { success: true };
        } catch (error) {
          logToFile(`Failed to set auto start: ${error}`);
          return { success: false, error: (error as Error).message };
        }
      });

      handle('get-auto-start', NO_ARGS, () => {
        try {
          const loginItemSettings = app.getLoginItemSettings();
          return loginItemSettings.openAtLogin;
        } catch (error) {
          logToFile(`Failed to get auto start status: ${error}`);
          return false;
        }
      });

      // Start minimized handler
      handle('start-minimized', NO_ARGS, () => {
        const win = getMainWindow();
        if (win) {
          win.minimize();
          logToFile('Application started minimized');
          return { success: true };
        }
        return { success: false, error: 'Window not available' };
      });

      // Update check IPC handlers
      handle('check-for-updates', NO_ARGS, async () => {
        logToFile('Manual update check requested');
        try {
          const result = await checkForUpdates();
          logToFile(`Update check result: ${JSON.stringify(result)}`);
          return result;
        } catch (error) {
          logToFile(`Update check error: ${error}`);
          return { updateAvailable: false, currentVersion: getCurrentVersion(), error: (error as Error).message };
        }
      });

      handle('get-app-version', NO_ARGS, () => {
        return getCurrentVersion();
      });

      handle('show-update-dialog', z.tuple([UpdateCheckResultSchema]), async (updateInfo) => {
        return await showUpdateDialog(updateInfo);
      });

      // Auto-update IPC handlers
      handle('download-and-install-update', z.tuple([UpdateCheckResultSchema]), async (updateInfo) => {
        logToFile('Manual download and install update requested');
        try {
          const { downloadAndInstallUpdate } = require('./update-service');
          const success = await downloadAndInstallUpdate(updateInfo);
          return { success };
        } catch (error) {
          logToFile(`Download/Install error: ${error}`);
          return { success: false, error: (error as Error).message };
        }
      });

      handle('set-auto-download', z.tuple([z.boolean()]), (enabled) => {
        try {
          const { setAutoDownload } = require('./update-service');
          setAutoDownload(enabled);
          logToFile(`Auto-download ${enabled ? 'enabled' : 'disabled'}`);
          return { success: true };
        } catch (error) {
          logToFile(`Failed to set auto-download: ${error}`);
          return { success: false, error: (error as Error).message };
        }
      });

      handle('set-auto-install', z.tuple([z.boolean()]), (enabled) => {
        try {
          const { setAutoInstall } = require('./update-service');
          setAutoInstall(enabled);
          logToFile(`Auto-install ${enabled ? 'enabled' : 'disabled'}`);
          return { success: true };
        } catch (error) {
          logToFile(`Failed to set auto-install: ${error}`);
          return { success: false, error: (error as Error).message };
        }
      });

      handle('get-download-status', NO_ARGS, () => {
        try {
          const { isCurrentlyDownloading, getDownloadProgress } = require('./update-service');
          return {
            isDownloading: isCurrentlyDownloading(),
            progress: getDownloadProgress()
          };
        } catch (error) {
          return { isDownloading: false, progress: 0, error: (error as Error).message };
        }
      });
      
      // Create the main window
      createWindow();
      
      // Initialize system integration settings after window is created
      setTimeout(() => {
        try {
          logToFile('Initializing system integration settings...');
          
          // Load saved settings from electron-store
          const closeToTray = store.get('closeToTray', false) as boolean;
          const minimizeToTray = store.get('minimizeToTray', false) as boolean;
          const checkUpdatesOnStartup = store.get('checkForUpdatesOnStartup', true) as boolean;
          
          logToFile(`Loaded settings - closeToTray: ${closeToTray}, minimizeToTray: ${minimizeToTray}`);
          console.log(`🔧 Loaded settings - closeToTray: ${closeToTray}, minimizeToTray: ${minimizeToTray}`);
          
          // Apply settings to main process flags
          setCloseToTray(closeToTray);
          setIsMinimizedToTray(minimizeToTray);
          
          // Set main window reference for update service
          setMainWindow(win);
          
          // Set main window reference for protocol handler and register protocol
          setProtocolMainWindow(win);
          // Under e2e the OS handler is not touched: registering would repoint the
          // developer's real dayzbeans:// links at a test instance.
          if (!e2eHooks) {
            registerProtocol();
          }
          logToFile('Protocol handler initialized');
          
          // Initialize Discord Rich Presence (not under e2e: it would talk to a real Discord)
          logToFile('🎮 Initializing Discord Rich Presence...');
          (e2eHooks ? Promise.resolve(false) : discordService.connect()).then(connected => {
            if (connected) {
              logToFile('✅ Discord Rich Presence initialized');
            } else {
              logToFile('⚠️ Discord Rich Presence not available (Discord may not be running)');
            }
          }).catch(error => {
            logToFile(`⚠️ Discord Rich Presence initialization failed: ${error}`);
          });
          
          // Check for updates on startup if enabled
          if (checkUpdatesOnStartup && !e2eHooks) {
            logToFile('Checking for updates on startup...');
            checkForUpdatesOnStartup(true).catch(error => {
              logToFile(`Startup update check failed: ${error}`);
            });
          }
          
          // BUG-002: Cleanup orphaned links then pre-warm junctions (non-blocking)
          setTimeout(async () => {
            try {
              logToFile('🧹 Cleaning up orphaned mod links...');
              await cleanupOrphanedLinks();
            } catch (error) {
              logToFile(`Orphaned link cleanup failed: ${error}`);
            }
            try {
              logToFile('🔥 Starting background junction pre-warming...');
              await preWarmJunctions();
            } catch (error) {
              logToFile(`Junction pre-warming failed: ${error}`);
            }
            // Then check every subscribed mod for updates and see them through. Runs
            // last: it is the longest task and the only one that touches the network.
            // Deliberately not awaited by anything — it reports to the renderer over
            // `mod-update-sweep` and stands aside if the player starts a join.
            //
            // Unconditional, and only ever downloads updates for mods the player already
            // has installed. A stale mod is not a preference: it is a server join that
            // fails with a message the player cannot act on.
            try {
              logToFile('🔄 Starting background mod update sweep...');
              const result = await sweepModUpdates();
              logToFile(`Mod update sweep: checked ${result.checked}, stale ${result.stale}, updated ${result.completed}, pending ${result.stillPending}`);
            } catch (error) {
              logToFile(`Mod update sweep failed: ${error}`);
            }
          }, 3000); // Wait 3 seconds after startup to avoid competing with other init tasks
          
          logToFile('Settings initialization complete');
        } catch (error) {
          logToFile(`Error initializing settings: ${error}`);
        }
      }, 1000); // Wait 1 second for renderer to be ready
    } catch (error) {
      logToFile(`Error during initialization: ${error}`);
    }
  }, 400));

  // Quit when all windows are closed
  app.on('window-all-closed', () => {
    // Cleanup Discord RPC before quitting
    discordService.disconnect().catch(err => {
      logToFile(`Error disconnecting Discord: ${err}`);
    });
    
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (win === null) {
      createWindow();
    }
  });

} catch (e) {
  logToFile(`Fatal error: ${e}`);
}
