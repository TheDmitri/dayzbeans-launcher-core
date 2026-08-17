/**
 * Production environment configuration
 * These values are used when building for production (npm run build:prod)
 * 
 * IMPORTANT: Update these URLs before deploying to production!
 * - Use HTTPS for all API endpoints
 * - Use domain names instead of IP addresses
 * - Update .env file on production server
 */
export const environment = {
  production: true,
  
  // API URLs - Production
  // TODO: Update these to use HTTPS and proper domain names
  // Example: authApiUrl: 'https://auth.yourdomain.com/api'
  apiUrl: 'https://api.dayzbeanslauncher.com/api',      // TODO: Use HTTPS and domain
  frontUrl: 'https://dayzbeanslauncher.com',
  
  // Feature Flags
  debugMode: false,
  enableSteam: true,
  enableReporting: true,
  
  // Server Configuration
  serverRefreshInterval: 30000, // 30 seconds
  pingTimeout: 5000, // 5 seconds
  
  // Application Settings
  appName: 'Day(Z) Beans Launcher',
  enableAutoUpdates: true,
  
  // GlitchTip Error Tracking
  //
  // The only step left to make launcher error reporting live. To fill it in:
  //   1. https://glitchtip.dayzbeanslauncher.com → the launcher project
  //      (Settings → Projects → create "launcher" if it does not exist yet)
  //   2. Settings → Client Keys (DSN) → copy the DSN
  //   3. paste it below, then rebuild the launcher
  //
  // Format: 'https://<public-key>@glitchtip.dayzbeanslauncher.com/<project-id>'
  //
  // A DSN is an ingest-only write key and ships inside every installed launcher
  // anyway, so it belongs here rather than in a sealed secret. It grants no read
  // access to the issues it creates.
  //
  // Empty is safe: SentryService logs a warning and disables itself, so the
  // launcher behaves exactly as it does today.
  sentryDsn: 'https://c27be1a984574273bcd96bbe49f75c60@glitchtip.dayzbeanslauncher.com/1'
};