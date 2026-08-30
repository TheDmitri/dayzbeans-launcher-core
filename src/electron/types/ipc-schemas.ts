/**
 * IPC Request/Response Schemas using Zod for runtime validation
 * These schemas ensure type safety for all IPC communication
 */

import { z } from 'zod';

// ============================================================================
// Primitives
//
// The values below are the ones that leave the main process again as a path
// segment, a shell-less argv entry, or a store key. They are constrained at the
// boundary rather than at each use site, so a new caller cannot forget.
// ============================================================================

/**
 * A Steam Workshop published-file id.
 *
 * Digits only, and that matters: this value is joined onto the workshop directory
 * (`path.join(workshopPath, workshopId)`) and used to build junction names
 * (`@${workshopId}`). A value of `../../..` would resolve outside the workshop
 * folder, and `open-mod-folder` hands the result to `shell.openPath`.
 */
export const WorkshopIdSchema = z
  .string()
  .regex(/^[0-9]{1,20}$/, 'must be a Steam Workshop id (digits only)');

export type WorkshopId = z.infer<typeof WorkshopIdSchema>;

/** Hostname or IP as accepted by the ping services. Length-capped so a hostile value cannot bloat a log line. */
export const HostSchema = z.string().min(1).max(255);

export const PortSchema = z.number().int().min(1).max(65535);

/** Millisecond timeout for a network probe. Bounded so a caller cannot pin a socket open indefinitely. */
export const TimeoutMsSchema = z.number().int().min(1).max(60_000);

/**
 * A URL handed to `shell.openExternal`.
 *
 * The scheme allowlist stays at the call site in ipc-handlers.ts -- it belongs
 * next to the `openExternal` call rather than in a schema someone might reuse for
 * a different purpose. This only bounds the shape and length.
 */
export const ExternalUrlSchema = z.string().min(1).max(2048);

/** An absolute filesystem path supplied by the user through a picker or a settings field. */
export const FilesystemPathSchema = z.string().max(4096);

/** A server name used only for display (window titles, Discord presence). */
export const ServerLabelSchema = z.string().max(256);

export const PlayerCountSchema = z.number().int().nonnegative().max(10_000);

export const ModCountSchema = z.number().int().nonnegative().max(10_000);

/**
 * Batch ceilings for the two channels that accept arrays.
 *
 * Both are well above any real payload -- a server's mod list runs to dozens and
 * the server browser pings a page at a time. They exist so an array argument
 * cannot be used to make the main process do unbounded work.
 */
export const MAX_PING_BATCH = 5000;
export const MAX_WORKSHOP_BATCH = 1000;

/**
 * A key for the generic store channels.
 *
 * electron-store treats a key as a dot-path, so `__proto__.polluted` is a write
 * into Object.prototype rather than into the config file. The segment check is
 * what stops that; the length cap keeps a runaway key out of the config.
 */
export const StoreKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (key) => !key.split('.').some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor'),
    'must not traverse the object prototype'
  );

/**
 * Ceiling on the offline snapshot written to disk.
 *
 * A 2000-server snapshot is ~540 KB, so 8 MB is far above any real payload. This is
 * the bound that matters for these channels: `payload` is stored opaque rather than
 * parsed, so the cap -- not a structural schema -- is what stops a compromised
 * renderer from filling the user's disk.
 */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The snapshot envelope as written to `<userData>/server-snapshot.json`.
 *
 * `payload` stays an opaque string on purpose. Zod-validating 2000 nested server rows
 * on every write would cost main-process CPU for no security benefit: the bytes come
 * from our own HTTPS backend and are handed straight back to the renderer, which
 * validates the structure as part of decoding it. Keeping it a string also avoids a
 * structured clone of a 2000-object graph across the bridge.
 */
export const SnapshotEnvelopeSchema = z.object({
  formatVersion: z.number().int().positive(),
  fetchedAt: z.number().int().nonnegative(),
  generatedAt: z.string().max(64),
  etag: z.string().max(128).nullable(),
  limit: z.number().int().min(1).max(5000),
  payload: z.string().min(1).max(SNAPSHOT_MAX_BYTES)
});

// ============================================================================
// Server Schemas
// ============================================================================

// Server data schema
// Matches the payload built by the renderer in server.service.ts. workshopId is sent
// as a number; accept string too for resilience. Premium/owner-editable fields are
// optional and only present for promoted servers.
export const ServerModSchema = z.object({
  // Renderer sends workshopId as a number; coerce so a string is also accepted.
  // Integer and non-negative because it becomes a directory name (`@${workshopId}`)
  // under the DayZ root -- see createWorkshopIdSymlinks in mod-management.ts.
  workshopId: z.coerce.number().int().nonnegative(),
  name: z.string().optional().default('')
});

export const ServerDataSchema = z.object({
  ip: z.string(),
  port: z.number().min(1).max(65535),
  name: z.string().optional(),
  password: z.string().optional(),
  isPromoted: z.boolean().optional(),
  description: z.string().optional(),
  trailerUrl: z.string().optional(),
  bannerUrl: z.string().optional(),
  discordUrl: z.string().optional(),
  websiteUrl: z.string().optional(),
  mods: z.array(ServerModSchema).optional()
});

export type ServerData = z.infer<typeof ServerDataSchema>;

export const JoinServerResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional()
});

export type JoinServerResponse = z.infer<typeof JoinServerResponseSchema>;

// ============================================================================
// Steam Workshop Schemas
// ============================================================================

export const SteamUserInfoSchema = z.object({
  success: z.boolean(),
  steamId: z.string().optional(),
  personaName: z.string().optional(),
  avatarUrl: z.string().optional(),
  error: z.string().optional()
});

export type SteamUserInfo = z.infer<typeof SteamUserInfoSchema>;

export const WorkshopItemSchema = z.object({
  publishedFileId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  fileSize: z.number().optional(),
  isInstalled: z.boolean().optional(),
  isDownloading: z.boolean().optional(),
  downloadProgress: z.number().optional()
});

export type WorkshopItem = z.infer<typeof WorkshopItemSchema>;

export const SteamSubscribedItemsSchema = z.object({
  success: z.boolean(),
  items: z.array(WorkshopItemSchema).optional(),
  error: z.string().optional()
});

export type SteamSubscribedItems = z.infer<typeof SteamSubscribedItemsSchema>;

export const SteamItemOperationSchema = z.object({
  success: z.boolean(),
  publishedFileId: z.string().optional(),
  error: z.string().optional()
});

export type SteamItemOperation = z.infer<typeof SteamItemOperationSchema>;

// ============================================================================
// File Dialog Schemas
// ============================================================================

export const FileDialogOptionsSchema = z.object({
  title: z.string().optional(),
  defaultPath: z.string().optional(),
  buttonLabel: z.string().optional(),
  filters: z.array(z.object({
    name: z.string(),
    extensions: z.array(z.string())
  })).optional(),
  properties: z.array(z.enum([
    'openFile',
    'openDirectory',
    'multiSelections',
    'showHiddenFiles',
    'createDirectory',
    'promptToCreate',
    'noResolveAliases',
    'treatPackageAsDirectory'
  ])).optional()
});

export type FileDialogOptions = z.infer<typeof FileDialogOptionsSchema>;

export const FileDialogResponseSchema = z.object({
  canceled: z.boolean(),
  filePaths: z.array(z.string()).optional()
});

export type FileDialogResponse = z.infer<typeof FileDialogResponseSchema>;

// ============================================================================
// Notification Schemas
// ============================================================================

export const NotificationSchema = z.object({
  title: z.string(),
  body: z.string(),
  icon: z.string().optional()
});

export type Notification = z.infer<typeof NotificationSchema>;

// ============================================================================
// Store Data Schemas
// ============================================================================

export const StoreDataRequestSchema = z.object({
  key: z.string(),
  value: z.unknown().optional()
});

export type StoreDataRequest = z.infer<typeof StoreDataRequestSchema>;

export const StoreDataResponseSchema = z.object({
  success: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().optional()
});

export type StoreDataResponse = z.infer<typeof StoreDataResponseSchema>;

// ============================================================================
// Update Schemas
// ============================================================================

export const UpdateInfoSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  releaseNotes: z.string().optional(),
  downloadUrl: z.string().optional()
});

export type UpdateInfo = z.infer<typeof UpdateInfoSchema>;

export const UpdateProgressSchema = z.object({
  percent: z.number().min(0).max(100),
  bytesPerSecond: z.number().optional(),
  transferred: z.number().optional(),
  total: z.number().optional()
});

export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

// ============================================================================
// Game Launch Schemas
// ============================================================================

export const LaunchGameRequestSchema = z.object({
  serverIp: z.string(),
  serverPort: z.number().int().min(1).max(65535),
  parameters: z.string().optional()
});

export type LaunchGameRequest = z.infer<typeof LaunchGameRequestSchema>;

export const LaunchGameResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional()
});

export type LaunchGameResponse = z.infer<typeof LaunchGameResponseSchema>;

// ============================================================================
// Path Detection Schemas
// ============================================================================

export const PathDetectionResponseSchema = z.object({
  success: z.boolean(),
  path: z.string().optional(),
  error: z.string().optional()
});

export type PathDetectionResponse = z.infer<typeof PathDetectionResponseSchema>;

// ============================================================================
// Mod Management Schemas
// ============================================================================

export const ModInstallInfoSchema = z.object({
  isInstalled: z.boolean(),
  installPath: z.string().optional(),
  sizeOnDisk: z.number().optional(),
  lastUpdated: z.number().optional()
});

export type ModInstallInfo = z.infer<typeof ModInstallInfoSchema>;

export const ModDownloadInfoSchema = z.object({
  isDownloading: z.boolean(),
  bytesDownloaded: z.number().optional(),
  bytesTotal: z.number().optional(),
  progress: z.number().min(0).max(100).optional()
});

export type ModDownloadInfo = z.infer<typeof ModDownloadInfoSchema>;

// ============================================================================
// Payload Schemas For Individual Channels
//
// Everything below describes one channel's arguments. They live here rather than
// inline in ipc-handlers.ts so that the complete accepted input surface of the
// main process can be read in one file -- which is the first thing anyone
// auditing this codebase wants.
// ============================================================================

/** `ping-servers-gamedig` -- one entry per server to probe. */
export const GameDigTargetSchema = z.object({
  ip: HostSchema,
  queryPort: PortSchema,
  serverId: z.number().int()
});

export type GameDigTarget = z.infer<typeof GameDigTargetSchema>;

/**
 * `clone-dayz-profile`.
 *
 * Names become directory names under the profiles folder, so they are restricted
 * to what a profile name can legitimately contain: no separators, no traversal,
 * nothing the Win32 API rejects.
 */
export const ProfileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^<>:"/\\|?* -]+$/, 'must not contain path separators or reserved characters')
  .refine((name) => name !== '.' && name !== '..', 'must not be a relative path');

export const CloneProfileRequestSchema = z.object({
  sourceName: ProfileNameSchema,
  sourceDirectory: z.string().max(4096).optional(),
  newName: ProfileNameSchema
});

export type CloneProfileRequest = z.infer<typeof CloneProfileRequestSchema>;

/**
 * `save-settings`.
 *
 * Every field is optional because the renderer syncs partial settings, and each is
 * written to electron-store only when present. Unknown keys are stripped rather
 * than rejected: an older launcher receiving a newer renderer's payload should
 * save what it understands instead of failing the whole save.
 */
export const SettingsPayloadSchema = z.object({
  dayzPath: z.string().max(4096).optional(),
  launchParameters: z.string().max(4096).optional(),
  profileName: z.string().max(64).optional(),
  profilesPath: z.string().max(4096).optional(),
  serverPassword: z.string().max(256).optional(),
  windowMode: z.boolean().optional(),
  noPause: z.boolean().optional(),
  autoLaunch: z.boolean().optional(),
  minimizeToTray: z.boolean().optional(),
  startMinimized: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  enableNotifications: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
  checkForUpdatesOnStartup: z.boolean().optional(),
  hideDiscordServerDetails: z.boolean().optional(),
  crashReporting: z.boolean().optional()
});

export type SettingsPayload = z.infer<typeof SettingsPayloadSchema>;

/**
 * `discord-update-presence` -- mirrors PresenceData in discord-service.ts.
 *
 * The state list must stay in step with PresenceState there; the compiler enforces
 * it, because the parsed object is passed straight to discordService.updatePresence.
 */
export const PresenceDataSchema = z.object({
  state: z.enum(['browsing', 'viewing', 'connecting', 'downloading', 'playing', 'mods']),
  serverName: z.string().max(256).optional(),
  serverIp: HostSchema.optional(),
  serverPort: PortSchema.optional(),
  playerCount: z.number().int().nonnegative().optional(),
  maxPlayers: z.number().int().nonnegative().optional(),
  modCount: z.number().int().nonnegative().optional(),
  downloadProgress: z.number().min(0).max(100).optional(),
  isPremiumServer: z.boolean().optional()
});

/**
 * `show-update-dialog` and `download-and-install-update`.
 *
 * This is the renderer echoing back a result the main process produced, but it is
 * validated like anything else: `downloadUrl` reaches `shell.openExternal` and
 * `checksum` is what the downloaded installer is verified against, so neither can
 * be taken on trust just because of where it is supposed to have come from.
 */
export const UpdateCheckResultSchema = z.object({
  updateAvailable: z.boolean(),
  currentVersion: z.string().max(64),
  latestVersion: z.string().max(64).optional(),
  downloadUrl: ExternalUrlSchema.optional(),
  releaseNotes: z.string().max(32_768).optional(),
  isMandatory: z.boolean().optional(),
  fileSize: z.number().nonnegative().optional(),
  checksum: z.string().max(256).optional(),
  error: z.string().max(4096).optional()
});

export type UpdateCheckResultInput = z.infer<typeof UpdateCheckResultSchema>;

// ============================================================================
// Validation Helper Functions
// ============================================================================

/**
 * Validates data against a schema and returns typed result
 * @param schema Zod schema to validate against
 * @param data Data to validate
 * @returns Validated and typed data
 * @throws ZodError if validation fails
 */
export function validateIPC<T>(schema: z.ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

/**
 * Safely validates data and returns result with error handling
 * @param schema Zod schema to validate against
 * @param data Data to validate
 * @returns Object with success flag and either data or error
 */
export function safeValidateIPC<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  try {
    const result = schema.safeParse(data);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    };
  } catch (error) {
    return {
      success: false,
      error: `Validation error: ${(error as Error).message}`
    };
  }
}

// A `createValidatedHandler` wrapper used to live here. It took `event: any`, it
// was never called from anywhere, and its presence made the IPC surface look
// validated while 75 of 77 channels parsed nothing. Registration now goes through
// `handle()` in ../ipc-register.ts, which cannot be called without a schema.
