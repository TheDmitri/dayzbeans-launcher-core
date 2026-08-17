/**
 * Which environment this Electron main-process bundle was built for.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Angular's `fileReplacements` swap src/environments/environment.ts for the prod or
 * staging copy, but they only apply to the Angular build. The Electron main process
 * is a plain `tsc -p tsconfig.electron.json`, which has no such mechanism and always
 * resolved environment.ts -- the *development* file, whose URLs point at staging.
 *
 * That was not theoretical. `getApiUrls()` in ./environment.ts feeds
 * update-service.ts, so every shipped production launcher was checking for updates
 * against https://staging-api.dayzbeanslauncher.com. sentry.ts had already noticed
 * the same trap and worked around it with `app.isPackaged` -- which cannot help now,
 * because a staging build and a production build are both packaged.
 *
 * HOW IT IS SET
 * =============
 * The value below is rewritten at build time by launcher/scripts/set-build-env.js,
 * which `npm run build:electron` (production) and `npm run build:electron:staging`
 * both invoke. The committed default is `production` so that an unconfigured build
 * is the safe one.
 *
 * Because it is a build artifact rather than a decision, CI does not trust it: the
 * launcher workflow greps the COMPILED dist-electron/config/build-env.js and fails
 * the build if it does not match the environment the run resolved.
 */
export type BuildEnvironment = 'production' | 'staging';

export const BUILD_ENV: BuildEnvironment = 'production';
