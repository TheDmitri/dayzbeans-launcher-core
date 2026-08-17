/**
 * Staging environment configuration
 *
 * Used by `npm run build:angular:staging`, which is what CI builds when the launcher
 * workflow runs from the `dev` branch. Before this existed the workflow hardcoded
 * `build:angular:prod`, so a launcher built from dev talked to the PRODUCTION API and
 * reported errors into the PRODUCTION GlitchTip project.
 *
 * This is a real shipping build, not a dev build: `production: true` so Angular's
 * production mode is enabled and the packaged app behaves like the released one. The
 * only differences from environment.prod.ts are the hostnames and the GlitchTip
 * project. Keep it that way -- the point of staging is that it is production with
 * different URLs.
 *
 * Known wrinkle: SentryService tags events `production` whenever `production` is
 * true, so staging events carry that tag. They still land in a separate GlitchTip
 * project (id 2 vs id 1 below), so the two streams do not mix.
 *
 * For local `npm start`, see environment.ts. For releases, see environment.prod.ts.
 */
export const environment = {
  production: true,

  // API URLs - Staging. These are the hosts k8s/overlays/staging/ingress.yaml serves.
  apiUrl: 'https://staging-api.dayzbeanslauncher.com/api',
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
  // Project 2, the same non-production project environment.ts uses, so staging noise
  // never reaches the project that production alerts on (project 1).
  sentryDsn: 'https://d48872f28f124e1080998a4f1b6ac11e@glitchtip.dayzbeanslauncher.com/2'
};
