/**
 * Type definitions for Electron IPC API
 * These types ensure type safety between the main process and renderer process
 */

export interface ServerModData {
  workshopId: number;
  name: string;
}

export interface ServerData {
  ip: string;
  port: number;
  name?: string;
  mods?: ServerModData[];
  parameters?: string;
  password?: string;
  edition?: 'stable' | 'experimental';
  /** Opaque key of a server on this PC whose non-Workshop mods the player chose to load. */
  localServerKey?: string;
}

/** A DayZ server found by Direct Connect (main: local-servers/local-server-discovery.ts). */
export interface DayZServerProbe {
  ip: string;
  gamePort: number;
  queryPort: number;
  /** process: a DayZServer on this PC; loopback: answers on 127.0.0.1; lan; address: typed. */
  source: 'process' | 'loopback' | 'lan' | 'address';
  /** False for a DayZServer process that does not answer queries (yet). */
  online: boolean;
  name: string;
  map: string;
  players: number;
  maxPlayers: number;
  version: string;
  appId: number | null;
  edition: 'stable' | 'experimental';
  passwordProtected: boolean;
  firstPerson: boolean;
  pingMs: number | null;
  /** Workshop mods the server needs; null when unknown. */
  mods: ServerModData[] | null;
  /** Mods that are not on the Workshop (names only). */
  unpublishedMods: Array<{ name: string }>;
  modsSource: 'rules' | 'process' | 'none';
  modsComplete: boolean;
  /** Present when the main process can load the unpublished mods from the server's folders. */
  localServerKey?: string;
}

export interface LocalServerDiscoveryResult {
  servers: DayZServerProbe[];
  scannedPorts: number[];
  lanScanned: boolean;
  tookMs: number;
}

export type DayZServerQueryResult =
  | { ok: true; server: DayZServerProbe }
  | { ok: false; reason: 'timeout' | 'dns' | 'mismatch' | 'rejected' | 'rate-limited'; triedPorts: number[] };

// GameDig ping result types
export interface GameDigPingResult {
  success: boolean;
  ping: number;
  error?: string;
  serverInfo?: {
    name: string;
    map: string;
    players: number;
    maxPlayers: number;
  };
}

export interface GameDigBatchPingResult extends GameDigPingResult {
  serverId: number;
}

export interface DayZProfile {
  /** Profile name as DayZ knows it: the `.DayZProfile` filename without extension. */
  name: string;
  /** Directory the profile file lives in — the value for `-profiles=`. */
  directory: string;
  /** mtime in ms, used to surface the most recently played profile first. */
  modifiedAt: number;
  /** True when `directory` is the resolved default Documents\DayZ folder. */
  isDefaultDirectory: boolean;
}

export interface DayZProfileListResult {
  success: boolean;
  defaultProfilesPath: string;
  profiles: DayZProfile[];
  error?: string;
}

export interface DayZProfileCloneResult {
  success: boolean;
  /** The profile the copy created, ready to be pinned through `-name`. */
  profile?: DayZProfile;
  /** Filenames written, for logging. */
  copiedFiles?: string[];
  error?: string;
}

export interface OpenProfilesFolderResult {
  success: boolean;
  /** The folder that was opened, or the one that is missing — shown either way. */
  path: string;
  error?: string;
}

export interface ResolveProfilesFolderResult {
  success: boolean;
  /** The concrete folder behind an empty "Game Settings Path". */
  path: string;
  exists: boolean;
  error?: string;
}

export interface DayZProfileDriftResult {
  success: boolean;
  /** A profile DayZ created since the last launch — usually an in-game rename. */
  profile: DayZProfile | null;
  error?: string;
}

export interface SteamUserInfo {
  success: boolean;
  steamId?: string;
  personaName?: string;
  avatarUrl?: string;
  error?: string;
}

/**
 * Why Steam could not be reached. `reason` is the machine-readable cause the
 * "Steam not detected" modal maps to a localized explanation; `headline` is the
 * untranslated fallback so an unmapped code still says something useful.
 */
export type SteamReasonCode =
  | 'ready'
  | 'disabled'
  | 'native-module-blocked'
  | 'elevation-mismatch'
  | 'steam-not-installed'
  | 'steam-not-running'
  | 'steam-api-unreachable'
  | 'unknown';

export interface SteamDiagnostics {
  generatedAt: string;
  reason: SteamReasonCode;
  headline: string;
  rawError: string | null;
  app: { version: string; packaged: boolean; platform: string; arch: string; osRelease: string; locale: string };
  process: { cwd: string; cwdWritable: boolean; execPath: string; elevated: boolean | null; launchedFromProtocol: boolean };
  steam: {
    initialized: boolean;
    lastFailure: { stage: string; message: string; code?: string; at: string; attempts: number } | null;
    appIdFile: { path: string; written: boolean; error: string | null } | null;
    installation: { type: string; isInstalled: boolean; isRunning: boolean; installPath: string | null } | null;
    running: boolean;
    windowsRegistry: { installPath: string | null; installPathSource: string | null; activePid: number | null } | null;
  };
  logFile: string;
}

export interface SteamDiagnosticsResponse {
  success: boolean;
  diagnostics?: SteamDiagnostics;
  /** Redacted plain-text report, ready to paste into a support thread. */
  report?: string;
  error?: string;
}

export interface SteamSubscribedItemsResponse {
  success: boolean;
  items?: SteamWorkshopItem[];
  error?: string;
}

export interface SteamWorkshopItem {
  publishedFileId: string;
  title: string;
  description?: string;
  previewUrl?: string;
  fileSize?: number;
  timeUpdated?: number;
  tags?: string[];
  subscriptions?: number;
}

export interface SteamItemResponse {
  success: boolean;
  error?: string;
  method?: 'steamworks' | 'protocol';
  requiresManualSubscribe?: boolean;
  steamType?: 'native' | 'flatpak';
  workshopUrl?: string;
  downloadStarted?: boolean;
}

export interface SteamItemInstallInfo {
  success: boolean;
  isInstalled?: boolean;
  folder?: string;
  sizeOnDisk?: number;
  timestamp?: number;
  error?: string;
}

export interface WorkshopItemDetails {
  success: boolean;
  workshopId?: string;
  title?: string;
  description?: string;
  timeCreated?: number;
  timeUpdated?: number;
  fileSize?: number;
  tags?: string[];
  previewUrl?: string;
  error?: string;
}

export interface WorkshopItemDetailsBatchResponse {
  success: boolean;
  items?: WorkshopItemDetails[];
  failedItems?: { workshopId: string; error: string }[];
  successCount?: number;
  failCount?: number;
  loadTime?: number;
  error?: string;
}

export interface SteamItemDownloadInfo {
  success: boolean;
  bytesDownloaded?: number;
  bytesTotal?: number;
  active?: boolean;
  itemState?: number;
  isInstalled?: boolean;
  isDownloading?: boolean;
  isDownloadPending?: boolean;
  error?: string;
}

export interface ModInstallStatus {
  success: boolean;
  isInstalled?: boolean;
  itemState?: number;
  isSubscribed?: boolean;
  stateInstalled?: boolean;
  folderExists?: boolean;
  installPath?: string;
  error?: string;
}

export interface ModSizeInfo {
  workshopId: string;
  size: number;
  name?: string;
  error?: string;
}

export interface ModSizesResponse {
  success: boolean;
  mods?: ModSizeInfo[];
  totalSize?: number;
  totalSizeFormatted?: string;
  successCount?: number;
  failCount?: number;
  error?: string;
}

export interface NotificationOptions {
  title: string;
  body: string;
  icon?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  isMandatory?: boolean;
  fileSize?: number;
  error?: string;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

/**
 * Discord Rich Presence types
 */
export type DiscordPresenceState = 
  | 'browsing'
  | 'viewing'
  | 'connecting'
  | 'downloading'
  | 'playing'
  | 'mods';

export interface DiscordPresenceData {
  state: DiscordPresenceState;
  serverName?: string;
  serverIp?: string;
  serverPort?: number;
  playerCount?: number;
  maxPlayers?: number;
  modCount?: number;
  downloadProgress?: number;
  isPremiumServer?: boolean;
}

export interface DiscordPresenceResult {
  success: boolean;
  error?: string;
}

export interface DiscordAPI {
  updatePresence: (data: DiscordPresenceData) => Promise<DiscordPresenceResult>;
  setBrowsing: () => Promise<DiscordPresenceResult>;
  setViewingServer: (serverName: string, serverIp?: string, serverPort?: number, playerCount?: number, maxPlayers?: number, isPremiumServer?: boolean) => Promise<DiscordPresenceResult>;
  setConnecting: (serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean) => Promise<DiscordPresenceResult>;
  setDownloading: (modCount?: number, downloadProgress?: number, serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean) => Promise<DiscordPresenceResult>;
  setPlaying: (serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean, playerCount?: number, maxPlayers?: number) => Promise<DiscordPresenceResult>;
  setManagingMods: (modCount?: number) => Promise<DiscordPresenceResult>;
  clearPresence: () => Promise<DiscordPresenceResult>;
  isConnected: () => Promise<boolean>;
}

/**
 * App Suspension types for resource management
 */
export interface SuspensionState {
  isSuspended: boolean;
  suspendedAt: number | null;
  reason: 'minimized' | 'hidden' | 'system_sleep' | null;
}

export interface SuspensionAPI {
  getState: () => Promise<SuspensionState>;
  onSuspended: (callback: (data: { reason: string }) => void) => () => void;
  onResumed: (callback: (data: { suspendedDuration: number }) => void) => () => void;
}

/**
 * Main Electron API exposed to renderer process via contextBridge
 */
/**
 * Whether a mod on disk is the version the workshop has.
 * `isUpToDate` is the only field a caller should gate a launch on — it folds in
 * "installed", "not stale" and "nothing in flight".
 */
export interface ModUpdateStatusResponse {
  success: boolean;
  workshopId: string;
  itemState: number;
  isInstalled: boolean;
  needsUpdate: boolean;
  isDownloading: boolean;
  isUpToDate: boolean;
  folder: string | null;
  localTimestamp: number;
  workshopTimestamp: number;
  /** Newest workshop version known to need no download (metadata-only edit), or 0. */
  acknowledgedTimestamp: number;
  reason:
    | 'up-to-date'
    | 'not-installed'
    | 'folder-missing'
    | 'steam-flag'
    | 'timestamp'
    | 'metadata-only'
    | 'downloading'
    | 'steam-unavailable'
    | 'error';
  error?: string;
}

/** Outcome of a full subscribed-mod update sweep. */
export interface ModUpdateSweepResponse {
  ran: boolean;
  checked: number;
  stale: number;
  completed: number;
  stillPending: number;
  reason?: string;
}

/** Progress pushed on the `mod-update-sweep` channel while a sweep runs. */
export interface ModUpdateSweepProgress {
  phase: 'checking' | 'updating' | 'done' | 'skipped';
  checked?: number;
  total?: number;
  stale?: number;
  completed?: number;
  names?: string[];
  error?: string;
}

export interface ElectronAPI {
  // Spotlight
  getSpotlightServerId: () => Promise<{ serverId: number | null; joinRequested: boolean }>;

  // Window Controls
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  forceQuit: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  toggleFullscreen: () => Promise<void>;
  isFullscreen: () => Promise<boolean>;

  // Server Functionality
  joinServer: (serverData: ServerData) => Promise<void>;
  pingServer: (host: string) => Promise<number>;
  pingServerGameDig: (ip: string, queryPort: number, timeout?: number) => Promise<GameDigPingResult>;
  pingServersGameDig: (servers: Array<{ ip: string; queryPort: number; serverId: number }>, concurrency?: number, timeout?: number) => Promise<GameDigBatchPingResult[]>;
  getServerInfoGameDig: (ip: string, queryPort: number, timeout?: number) => Promise<GameDigPingResult>;
  clearPingCache: () => Promise<{ success: boolean }>;
  discoverLocalServers: (options: { lan: boolean }) => Promise<LocalServerDiscoveryResult>;
  queryDayZServer: (target: { host: string; gamePort: number; queryPortHint?: number }) => Promise<DayZServerQueryResult>;

  // Steam Workshop Integration
  isSteamInitialized: () => Promise<boolean>;
  ensureSteamInitialized: () => Promise<boolean>;
  getSteamStatus: () => Promise<{ ready: boolean; phase: 'pending' | 'ready' | 'unavailable' }>;
  isSteamRunning: () => Promise<boolean>;
  detectSteamInstallation: () => Promise<{ type: 'native' | 'flatpak' | 'none'; command: string; supportsNativeAPI: boolean; isInstalled: boolean; isRunning: boolean; installPath: string | null }>;
  getSteamDiagnostics: () => Promise<SteamDiagnosticsResponse>;
  openLogFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
  isModInstalledOnDisk: (workshopId: string) => Promise<boolean>;
  getInstalledModsFromDisk: () => Promise<string[]>;
  getSteamUserInfo: () => Promise<SteamUserInfo>;
  getSteamSubscribedItems: () => Promise<SteamSubscribedItemsResponse>;
  getSteamSubscribedItemsFast: () => Promise<SteamSubscribedItemsResponse & { loadTime?: number }>;
  steamSubscribeItem: (publishedFileId: string) => Promise<SteamItemResponse>;
  steamUnsubscribeItem: (publishedFileId: string) => Promise<SteamItemResponse>;
  getSteamItemDownloadInfo: (publishedFileId: string) => Promise<SteamItemDownloadInfo>;
  getSteamItemInstallInfo: (publishedFileId: string) => Promise<SteamItemInstallInfo>;
  getWorkshopItemDetails: (publishedFileId: string) => Promise<WorkshopItemDetails>;
  getWorkshopItemDetailsBatch: (publishedFileIds: string[]) => Promise<WorkshopItemDetailsBatchResponse>;
  isModInstalled: (publishedFileId: string) => Promise<ModInstallStatus>;
  forceDownloadItem: (publishedFileId: string) => Promise<{ success: boolean; downloadStarted?: boolean; error?: string }>;
  getModUpdateStatus: (publishedFileId: string, queryWorkshop?: boolean) => Promise<ModUpdateStatusResponse>;
  getModUpdateStatuses: (publishedFileIds: string[]) => Promise<{ success: boolean; statuses: ModUpdateStatusResponse[] }>;
  sweepModUpdates: () => Promise<ModUpdateSweepResponse>;
  getModSizes: (workshopIds: string[]) => Promise<ModSizesResponse>;
  joinServerWithMods: (serverData: ServerData) => Promise<SteamItemResponse>;
  cancelJoinProcess: () => Promise<{ success: boolean; message?: string; error?: string }>;

  // Mod Folder
  openModFolder: (workshopId: string) => Promise<{ success: boolean; error?: string }>;

  // File System
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>;

  // Notifications
  showNotification: (options: NotificationOptions) => Promise<void>;

  // Updates
  checkForUpdates: () => Promise<UpdateCheckResult>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  showUpdateDialog: (updateInfo: UpdateCheckResult) => Promise<boolean>;

  // App Info
  getAppVersion: () => Promise<string>;
  /**
   * Anonymous install id, owned by the main process so it survives a renderer cache
   * wipe. `legacyId` is the old localStorage value, adopted only on first migration.
   */
  getAnonymousId: (legacyId?: string) => Promise<string>;

  // Store Data
  setStoreData: (key: string, value: any) => Promise<void>;
  getStoreData: (key: string) => Promise<any>;

  /** Offline server-list snapshot, stored in its own userData file. */
  snapshotWrite: (envelope: SnapshotEnvelope) => Promise<{ success: boolean; bytes: number; error?: string }>;
  snapshotRead: () => Promise<SnapshotEnvelope | null>;
  snapshotClear: () => Promise<{ success: boolean }>;
  snapshotStat: () => Promise<SnapshotStat>;
  deleteStoreData: (key: string) => Promise<void>;

  /**
   * Opens a URL in the default external browser
   */
  openExternal(url: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Environment Configuration
   */
  getApiUrls: () => Promise<{ apiUrl: string; authApiUrl: string }>;

  /**
   * System Integration
   */
  setCloseToTray: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  setMinimizeToTray: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  setAutoStart: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  getAutoStart: () => Promise<boolean>;
  startMinimized: () => Promise<{ success: boolean; error?: string }>;

  /**
   * DayZ Installation Verification
   */
  verifyDayZInstallation: () => Promise<{
    isInstalled: boolean;
    executablePath?: string;
    error?: string;
    needsConfiguration?: boolean;
    /** Why it was not found: 'uninstalled' when Steam removed the game but left its folder. */
    reason?: 'uninstalled' | 'not-found';
  }>;

  /** Executable path of each installed DayZ client, null when it is not installed. */
  findDayZEdition: (edition: 'stable' | 'experimental') => Promise<string | null>;
  /** Mute flipped from the taskbar thumbnail button or the tray menu; returns an unsubscribe. */
  onMusicMuteChanged: (callback: (muted: boolean) => void) => () => void;

  verifyDayZPath: (dayzPath: string) => Promise<{
    isInstalled: boolean;
    executablePath?: string;
    error?: string;
    needsConfiguration?: boolean;
  }>;

  listDayZProfiles: () => Promise<DayZProfileListResult>;

  cloneDayZProfile: (
    sourceName: string,
    sourceDirectory: string,
    newName: string
  ) => Promise<DayZProfileCloneResult>;

  checkDayZProfileDrift: () => Promise<DayZProfileDriftResult>;

  openProfilesFolder: () => Promise<OpenProfilesFolderResult>;

  resolveProfilesFolder: () => Promise<ResolveProfilesFolderResult>;

  saveSettings: (settings: any) => Promise<boolean>;

  /**
   * DayZ Process Management
   */
  isDayZRunning: () => Promise<{ success: boolean; isRunning: boolean; error?: string }>;
  killDayZProcesses: () => Promise<{ success: boolean; message?: string; error?: string }>;

  /**
   * App Control
   */
  restartApp: () => Promise<void>;

  /**
   * Protocol Handler
   * Listen for dayzbeans:// protocol actions
   */
  onProtocolAction: (callback: (action: ProtocolAction) => void) => () => void;

  /**
   * Discord Rich Presence
   */
  discord: DiscordAPI;

  /**
   * App Suspension - Resource management when minimized
   */
  suspension: SuspensionAPI;

  /**
   * Event Listeners
   */
  on: (channel: string, callback: (...args: any[]) => void) => (() => void);
  removeListener: (channel: string, callback: (...args: any[]) => void) => void;
}

/**
 * Protocol action received from dayzbeans:// URL
 */
export interface ProtocolAction {
  action: string;
  params: string[];
  query: Record<string, string>;
  rawUrl: string;
}

/**
 * Valid IPC channel names
 */
export type IPCChannel =
  | 'window-minimize'
  | 'window-maximize'
  | 'window-close'
  | 'window-is-maximized'
  | 'window-toggle-fullscreen'
  | 'window-is-fullscreen'
  | 'join-server'
  | 'ping-server'
  | 'ping-server-gamedig'
  | 'ping-servers-gamedig'
  | 'get-server-info-gamedig'
  | 'steam-is-initialized'
  | 'steam-is-running'
  | 'steam-detect-installation'
  | 'steam-init-status'
  | 'get-steam-status'
  | 'steam-get-user-info'
  | 'steam-get-subscribed-items'
  | 'steam-subscribe-item'
  | 'steam-unsubscribe-item'
  | 'steam-get-item-download-info'
  | 'steam-get-item-install-info'
  | 'is-mod-installed'
  | 'showOpenDialog'
  | 'open-external'
  | 'open-mod-folder'
  | 'mod-download-status'
  | 'mod-download-progress'
  | 'update-download-started'
  | 'update-download-progress'
  | 'update-download-complete'
  | 'update-download-error'
  | 'set-close-to-tray'
  | 'set-minimize-to-tray'
  | 'set-auto-start'
  | 'get-auto-start'
  | 'start-minimized'
  | 'snapshot-write'
  | 'snapshot-read'
  | 'snapshot-clear'
  | 'snapshot-stat'
  | 'setStoreData'
  | 'getStoreData'
  | 'deleteStoreData'
  | 'discord-update-presence'
  | 'discord-set-browsing'
  | 'discord-set-playing'
  | 'get-suspension-state'
  | 'app-suspended'
  | 'app-resumed'
  | 'protocol-action';

/** Envelope persisted at `<userData>/server-snapshot.json`. */
export interface SnapshotEnvelope {
  formatVersion: number;
  fetchedAt: number;
  generatedAt: string;
  etag: string | null;
  limit: number;
  /** Opaque snapshot JSON, decoded in the renderer. */
  payload: string;
}

export interface SnapshotStat {
  exists: boolean;
  bytes: number;
  fetchedAt: number | null;
  generatedAt: string | null;
}
