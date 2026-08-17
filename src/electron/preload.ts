import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { ElectronAPI, ServerData, OpenDialogOptions, NotificationOptions } from './types/electron-api';

/**
 * Preload script for Electron
 * Exposes a secure, typed API to the renderer process via contextBridge
 */

// Valid channels for IPC communication
const VALID_CHANNELS = [
  'get-spotlight-server-id',
  'window-minimize',
  'window-maximize',
  'window-close',
  'force-quit',
  'window-is-maximized',
  'window-toggle-fullscreen',
  'window-is-fullscreen',
  'show-notification',
  'showOpenDialog',
  'check-for-updates',
  'download-update',
  'install-update',
  'get-app-version',
  // Update broadcast channels (main → renderer, one-way via .on)
  'update-available',
  'update-downloaded',
  'update-download-started',
  'update-download-progress',
  'update-download-complete',
  'update-download-error',
  // Generic store data (camelCase invoke channels)
  'setStoreData',
  'getStoreData',
  'deleteStoreData',
  'steam-is-initialized',
  'steam-ensure-initialized',
  'steam-init-status',
  'get-steam-status',
  'steam-is-running',
  'steam-detect-installation',
  'steam-get-diagnostics',
  'open-log-folder',
  'is-mod-installed-on-disk',
  'get-installed-mods-from-disk',
  'steam-get-user-info',
  'steam-get-subscribed-items',
  'steam-subscribe-item',
  'steam-unsubscribe-item',
  'steam-get-item-download-info',
  'steam-get-item-install-info',
  'is-mod-installed',
  'join-server',
  'cancel-join-process',
  'ping-server',
  'open-external',
  'get-api-urls',
  'mod-download-status',
  'mod-download-progress',
  'set-close-to-tray',
  'set-minimize-to-tray',
  'set-auto-start',
  'get-auto-start',
  'start-minimized',
  'show-update-dialog',
  'protocol-action',
  'verify-dayz-installation',
  'list-dayz-profiles',
  'clone-dayz-profile',
  'check-dayz-profile-drift',
  'open-profiles-folder',
  'resolve-profiles-folder',
  // Discord Rich Presence channels
  'discord-update-presence',
  'discord-set-browsing',
  'discord-set-viewing-server',
  'discord-set-connecting',
  'discord-set-downloading',
  'discord-set-playing',
  'discord-set-managing-mods',
  'discord-clear-presence',
  'discord-is-connected',
  // App suspension channels
  'app-suspended',
  'app-resumed',
  'get-suspension-state',
  // Mod folder
  'open-mod-folder',
  // DayZ process management
  'is-dayz-running',
  'kill-dayz-processes',
  // App control
  'restart-app'
] as const;

/**
 * Validate channel name to prevent arbitrary IPC calls
 */
function isValidChannel(channel: string): boolean {
  return VALID_CHANNELS.includes(channel as typeof VALID_CHANNELS[number]);
}

/**
 * Registry mapping (channel → original callback → wrapped ipcRenderer listeners).
 * `on()` wraps each caller callback in a closure before registering it; this registry
 * lets `removeListener(channel, callback)` recover the wrapper(s) it actually registered.
 */
type IpcWrapper = (event: IpcRendererEvent, ...args: unknown[]) => void;
type RawCallback = (...args: unknown[]) => void;
const listenerRegistry = new Map<string, Map<RawCallback, Set<IpcWrapper>>>();

function registerWrapper(channel: string, callback: RawCallback, wrapper: IpcWrapper): void {
  let byCallback = listenerRegistry.get(channel);
  if (!byCallback) {
    byCallback = new Map();
    listenerRegistry.set(channel, byCallback);
  }
  let wrappers = byCallback.get(callback);
  if (!wrappers) {
    wrappers = new Set();
    byCallback.set(callback, wrappers);
  }
  wrappers.add(wrapper);
}

function unregisterWrapper(channel: string, callback: RawCallback, wrapper: IpcWrapper): void {
  const byCallback = listenerRegistry.get(channel);
  const wrappers = byCallback?.get(callback);
  if (!wrappers) return;
  wrappers.delete(wrapper);
  if (wrappers.size === 0) byCallback!.delete(callback);
  if (byCallback!.size === 0) listenerRegistry.delete(channel);
}

/** Returns and removes all wrappers registered for (channel, callback). */
function takeWrappers(channel: string, callback: RawCallback): IpcWrapper[] {
  const byCallback = listenerRegistry.get(channel);
  const wrappers = byCallback?.get(callback);
  if (!wrappers) return [];
  const list = Array.from(wrappers);
  byCallback!.delete(callback);
  if (byCallback!.size === 0) listenerRegistry.delete(channel);
  return list;
}

/**
 * Typed Electron API exposed to renderer process
 */
const electronAPI: ElectronAPI = {
  // Spotlight
  getSpotlightServerId: () => ipcRenderer.invoke('get-spotlight-server-id'),

  // Window Controls
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  forceQuit: () => ipcRenderer.invoke('force-quit'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  toggleFullscreen: () => ipcRenderer.invoke('window-toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),

  // Server Functionality
  joinServer: (serverData: ServerData) => ipcRenderer.invoke('join-server', serverData),
  pingServer: (host: string) => ipcRenderer.invoke('ping-server', host),
  pingServerGameDig: (ip: string, queryPort: number, timeout?: number) =>
    ipcRenderer.invoke('ping-server-gamedig', ip, queryPort, timeout),
  pingServersGameDig: (servers: Array<{ ip: string; queryPort: number; serverId: number }>, concurrency?: number, timeout?: number) =>
    ipcRenderer.invoke('ping-servers-gamedig', servers, concurrency, timeout),
  getServerInfoGameDig: (ip: string, queryPort: number, timeout?: number) =>
    ipcRenderer.invoke('get-server-info-gamedig', ip, queryPort, timeout),
  clearPingCache: () => ipcRenderer.invoke('clear-ping-cache'),

  // Steam Workshop Integration
  isSteamInitialized: () => ipcRenderer.invoke('steam-is-initialized'),
  ensureSteamInitialized: () => ipcRenderer.invoke('steam-ensure-initialized'),
  getSteamStatus: () => ipcRenderer.invoke('get-steam-status'),
  isSteamRunning: () => ipcRenderer.invoke('steam-is-running'),
  detectSteamInstallation: () => ipcRenderer.invoke('steam-detect-installation'),
  getSteamDiagnostics: () => ipcRenderer.invoke('steam-get-diagnostics'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  isModInstalledOnDisk: (workshopId: string) => ipcRenderer.invoke('is-mod-installed-on-disk', workshopId),
  getInstalledModsFromDisk: () => ipcRenderer.invoke('get-installed-mods-from-disk'),
  getSteamUserInfo: () => ipcRenderer.invoke('steam-get-user-info'),
  getSteamSubscribedItems: () => ipcRenderer.invoke('steam-get-subscribed-items'),
  getSteamSubscribedItemsFast: () => ipcRenderer.invoke('steam-get-subscribed-items-fast'),
  steamSubscribeItem: (publishedFileId: string) => ipcRenderer.invoke('steam-subscribe-item', publishedFileId),
  steamUnsubscribeItem: (publishedFileId: string) => ipcRenderer.invoke('steam-unsubscribe-item', publishedFileId),
  getSteamItemDownloadInfo: (publishedFileId: string) => ipcRenderer.invoke('steam-get-item-download-info', publishedFileId),
  getSteamItemInstallInfo: (publishedFileId: string) => ipcRenderer.invoke('steam-get-item-install-info', publishedFileId),
  getWorkshopItemDetails: (publishedFileId: string) => ipcRenderer.invoke('steam-get-workshop-item-details', publishedFileId),
  getWorkshopItemDetailsBatch: (publishedFileIds: string[]) => ipcRenderer.invoke('steam-get-workshop-items-batch', publishedFileIds),
  isModInstalled: (publishedFileId: string) => ipcRenderer.invoke('is-mod-installed', publishedFileId),
  forceDownloadItem: (publishedFileId: string) => ipcRenderer.invoke('steam-force-download', publishedFileId),
  getModSizes: (workshopIds: string[]) => ipcRenderer.invoke('steam-get-mod-sizes', workshopIds),
  joinServerWithMods: (serverData: ServerData) => ipcRenderer.invoke('join-server', serverData),
  cancelJoinProcess: () => ipcRenderer.invoke('cancel-join-process'),

  // Mod Folder
  openModFolder: (workshopId: string) => ipcRenderer.invoke('open-mod-folder', workshopId),

  // File System
  showOpenDialog: (options: OpenDialogOptions) => ipcRenderer.invoke('showOpenDialog', options),

  // Notifications
  showNotification: (options: NotificationOptions) => ipcRenderer.invoke('show-notification', options),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  showUpdateDialog: (updateInfo: any) => ipcRenderer.invoke('show-update-dialog', updateInfo),

  // App Info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Store Data
  setStoreData: (key: string, value: any) => ipcRenderer.invoke('setStoreData', key, value),
  getStoreData: (key: string) => ipcRenderer.invoke('getStoreData', key),
  deleteStoreData: (key: string) => ipcRenderer.invoke('deleteStoreData', key),

  // External Links
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Environment Configuration
  getApiUrls: () => ipcRenderer.invoke('get-api-urls'),

  // System Integration
  setCloseToTray: (enabled: boolean) => ipcRenderer.invoke('set-close-to-tray', enabled),
  setMinimizeToTray: (enabled: boolean) => ipcRenderer.invoke('set-minimize-to-tray', enabled),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('set-auto-start', enabled),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  startMinimized: () => ipcRenderer.invoke('start-minimized'),

  // DayZ Installation Verification
  verifyDayZInstallation: () => ipcRenderer.invoke('verify-dayz-installation'),
  verifyDayZPath: (dayzPath: string) => ipcRenderer.invoke('verify-dayz-path', dayzPath),
  listDayZProfiles: () => ipcRenderer.invoke('list-dayz-profiles'),
  cloneDayZProfile: (sourceName: string, sourceDirectory: string, newName: string) =>
    ipcRenderer.invoke('clone-dayz-profile', { sourceName, sourceDirectory, newName }),
  checkDayZProfileDrift: () => ipcRenderer.invoke('check-dayz-profile-drift'),
  openProfilesFolder: () => ipcRenderer.invoke('open-profiles-folder'),
  resolveProfilesFolder: () => ipcRenderer.invoke('resolve-profiles-folder'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),

  // DayZ Process Management
  isDayZRunning: () => ipcRenderer.invoke('is-dayz-running'),
  killDayZProcesses: () => ipcRenderer.invoke('kill-dayz-processes'),

  // App Control
  restartApp: () => ipcRenderer.invoke('restart-app'),

  // Protocol Handler
  onProtocolAction: (callback: (action: any) => void) => {
    const subscription = (_event: IpcRendererEvent, action: any) => callback(action);
    ipcRenderer.on('protocol-action', subscription);
    return () => ipcRenderer.removeListener('protocol-action', subscription);
  },

  // Discord Rich Presence
  discord: {
    updatePresence: (data: any) => ipcRenderer.invoke('discord-update-presence', data),
    setBrowsing: () => ipcRenderer.invoke('discord-set-browsing'),
    setViewingServer: (serverName: string, serverIp?: string, serverPort?: number, playerCount?: number, maxPlayers?: number, isPremiumServer?: boolean) => 
      ipcRenderer.invoke('discord-set-viewing-server', serverName, serverIp, serverPort, playerCount, maxPlayers, isPremiumServer),
    setConnecting: (serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean) => 
      ipcRenderer.invoke('discord-set-connecting', serverName, serverIp, serverPort, isPremiumServer),
    setDownloading: (modCount?: number, downloadProgress?: number, serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean) => 
      ipcRenderer.invoke('discord-set-downloading', modCount, downloadProgress, serverName, serverIp, serverPort, isPremiumServer),
    setPlaying: (serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean, playerCount?: number, maxPlayers?: number) => 
      ipcRenderer.invoke('discord-set-playing', serverName, serverIp, serverPort, isPremiumServer, playerCount, maxPlayers),
    setManagingMods: (modCount?: number) => ipcRenderer.invoke('discord-set-managing-mods', modCount),
    clearPresence: () => ipcRenderer.invoke('discord-clear-presence'),
    isConnected: () => ipcRenderer.invoke('discord-is-connected'),
  },

  // App Suspension API
  suspension: {
    getState: () => ipcRenderer.invoke('get-suspension-state'),
    onSuspended: (callback: (data: { reason: string }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { reason: string }) => callback(data);
      ipcRenderer.on('app-suspended', handler);
      return () => ipcRenderer.removeListener('app-suspended', handler);
    },
    onResumed: (callback: (data: { suspendedDuration: number }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { suspendedDuration: number }) => callback(data);
      ipcRenderer.on('app-resumed', handler);
      return () => ipcRenderer.removeListener('app-resumed', handler);
    },
  },

  // Event Listeners
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    if (isValidChannel(channel)) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args);
      // Track the wrapper so removeListener(channel, callback) can find and remove it.
      // Without this, removeListener would be handed the caller's raw callback, which
      // was never the function actually registered on ipcRenderer, so it could never
      // unsubscribe.
      registerWrapper(channel, callback, subscription);
      ipcRenderer.on(channel, subscription);
      return () => {
        ipcRenderer.removeListener(channel, subscription);
        unregisterWrapper(channel, callback, subscription);
      };
    }
    throw new Error(`Invalid channel: ${channel}`);
  },

  removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
    if (!isValidChannel(channel)) {
      console.error(`Invalid IPC channel: ${channel}`);
      return;
    }
    const wrappers = takeWrappers(channel, callback);
    if (wrappers.length === 0) {
      // Fall back to removing the raw callback in case it was registered directly.
      ipcRenderer.removeListener(channel, callback);
      return;
    }
    for (const wrapper of wrappers) {
      ipcRenderer.removeListener(channel, wrapper);
    }
  }
};

// Expose the API to the renderer process via contextBridge
// This is the secure way to expose APIs when context isolation is enabled
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

console.log('Preload script loaded with context isolation enabled');
