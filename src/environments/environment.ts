/**
 * Development environment configuration
 * These values are used when running in development mode (npm start)
 * 
 * For production builds, see environment.prod.ts
 * For local overrides, create .env file (see .env.example)
 */
export const environment = {
  production: false,
  
  // API URLs - Development
  // Note: These are loaded from .env file if available
  //
  // Pointed at the local API so features can be exercised before they exist on
  // staging (staging answers 403 for endpoints it has not deployed yet). Swap
  // back to https://staging-api.dayzbeanslauncher.com/api to test against staging.
  apiUrl: 'http://localhost:8088/api',
  frontUrl: 'https://staging.dayzbeanslauncher.com',
  
  // Feature Flags
  debugMode: true,
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
  // Left empty on purpose for development: dev crashes are noise in the issue
  // feed, and SentryService disables itself when this is blank. Set it only to
  // test the reporting path itself, ideally against a separate GlitchTip project
  // so dev noise never lands in the production one.
  //
  // See environment.prod.ts for how to obtain a DSN.
  sentryDsn: 'https://d48872f28f124e1080998a4f1b6ac11e@glitchtip.dayzbeanslauncher.com/2'
};
