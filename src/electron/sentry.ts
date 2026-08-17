/**
 * GlitchTip error reporting for the Electron MAIN process.
 *
 * This module initializes on import and must be imported FIRST in main.ts, so
 * that a crash during the rest of the startup sequence is still reported.
 *
 * WHY THIS IS SEPARATE FROM THE RENDERER
 * --------------------------------------
 * The renderer reports through `@sentry/angular` (see
 * services/core/sentry.service.ts) and talks to GlitchTip directly over HTTP.
 * The usual `@sentry/electron` setup instead funnels renderer events through IPC
 * into the main process, which requires `@sentry/electron/preload` to load inside
 * the preload script. That cannot work here: the renderer runs with
 * `sandbox: true` (main.ts), and a sandboxed preload only gets a restricted
 * `require` — it cannot resolve an npm package unless the preload is bundled,
 * and preload.ts is compiled by plain `tsc`, not bundled.
 *
 * So the two processes report independently to the same project, tagged by
 * `process` so they can be told apart. Each carries its own copy of the Sentry
 * core; harmless, because they are separate OS processes with no shared state.
 *
 * WHAT THIS BUYS
 * --------------
 * Everything the renderer SDK cannot see: main-process exceptions, unhandled
 * rejections, update-service failures, and native crashes.
 */

import { app } from 'electron';
import Store from 'electron-store';
import * as Sentry from '@sentry/electron/main';
import { BUILD_ENV } from './config/build-env';

/**
 * Crash reporting is opt-out (Settings → Privacy). This is read here rather than
 * checked at each capture site on purpose: when it is off, `Sentry.init` is never
 * called, so no SDK is loaded into the process, no transport exists, and no
 * connection to GlitchTip is ever opened. "Disabled" means nothing is sent, not
 * that sending is filtered — which is the only version of the claim that survives
 * someone watching the traffic.
 *
 * `save-settings` (ipc-handlers.ts) writes this key, so the value here is the one
 * chosen during the previous session. The SDK must initialize before any window
 * exists, so a change takes effect on the next launch.
 */
const settingsStore = new Store();
const crashReportingEnabled = settingsStore.get('settings.crashReporting', true) !== false;

/**
 * The DSNs are kept here rather than read from config/environment.ts, because that
 * module used to resolve the wrong environment file under the Electron tsc build.
 * That trap is now closed by config/build-env.ts, but the DSN is a single literal
 * either way and there is no reason to route it through the config loader.
 *
 * `app.isPackaged` alone is no longer sufficient to choose. It distinguishes
 * packaged from `npm start`, but a STAGING build is packaged too, and staging crashes
 * must not land in the feed of real user errors. BUILD_ENV is what separates them.
 */
const PRODUCTION_DSN = 'https://c27be1a984574273bcd96bbe49f75c60@glitchtip.dayzbeanslauncher.com/1';

/**
 * Separate GlitchTip project (id 2), shared by staging builds and local development,
 * so neither reaches production's feed. Kept in step with `sentryDsn` in
 * environments/environment.ts and environments/environment.staging.ts, which point
 * the renderer at the same project.
 */
const DEVELOPMENT_DSN = 'https://d48872f28f124e1080998a4f1b6ac11e@glitchtip.dayzbeanslauncher.com/2';

const isProductionBuild = app.isPackaged && BUILD_ENV === 'production';
const environmentTag = app.isPackaged ? BUILD_ENV : 'development';

const dsn = crashReportingEnabled ? (isProductionBuild ? PRODUCTION_DSN : DEVELOPMENT_DSN) : null;

if (!crashReportingEnabled) {
  console.log('ℹ️ Crash reporting disabled by user setting — GlitchTip SDK not initialized');
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: environmentTag,

    // Ties an issue to the version that produced it. Matches the renderer, which
    // reports the same version, so both sides group under one release.
    release: `dayz-beans-launcher@${app.getVersion()}`,

    // Distinguishes main-process issues from renderer ones at a glance, since
    // both report into the same project.
    initialScope: {
      tags: { process: 'main' },
    },

    // GlitchTip does not implement the sessions API, so release-health envelopes
    // are rejected on arrival. `mainProcessSessionIntegration` is on by default
    // and would send them on every launch and quit — pure wasted traffic.
    //
    // Note this is NOT the `autoSessionTracking: false` that GlitchTip's own
    // Electron page suggests: that option was removed in Sentry v8 and would not
    // type-check against @sentry/electron 7.x.
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== 'MainProcessSession'),

    // Traces are supported, but the main process does almost nothing worth
    // tracing and every span costs bandwidth on a user's connection.
    tracesSampleRate: 0,

    // Screenshots are opt-in upstream and stay off: this is a game launcher, so a
    // frame could contain a username, a server IP, or whatever else is on screen.
    attachScreenshot: false,
  });
}

/**
 * True when main-process reporting is live. Only useful for logging — every
 * Sentry call is a safe no-op when the SDK was never initialized.
 */
export const isErrorReportingEnabled = Boolean(dsn);
