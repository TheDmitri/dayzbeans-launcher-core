/**
 * Environment configuration loader for Electron main process
 * Uses the same environment.ts files as Angular for consistency
 */

// The comment that used to sit here claimed "the build process will use the correct
// one". It did not: Angular's fileReplacements do not apply to the Electron tsc
// build, so this module always resolved environment.ts -- the development file --
// and shipped its staging URLs inside production launchers. getApiUrls() below feeds
// update-service.ts, so released builds were checking for updates against staging.
//
// Both files are imported explicitly and selected by BUILD_ENV, which
// scripts/set-build-env.js stamps in at build time. Nothing here depends on which
// file the module resolver happens to pick.
import { environment as productionEnvironment } from '../../environments/environment.prod';
import { environment as stagingEnvironment } from '../../environments/environment.staging';
import { BUILD_ENV } from './build-env';

const environment = BUILD_ENV === 'production' ? productionEnvironment : stagingEnvironment;

interface EnvironmentConfig {
  // API Configuration
  apiUrl: string;
  
  // Environment
  production: boolean;
  
  // Feature Flags
  debugMode: boolean;
  enableSteam: boolean;
  enableReporting: boolean;
  
  // Server Configuration
  serverRefreshInterval: number;
  pingTimeout: number;
  
  // Mod Management
  steamAppId: number;
  maxConcurrentDownloads: number;
  
  // Application Settings
  appName: string;
  enableAutoUpdates: boolean;
}

/**
 * Load environment configuration from Angular environment files
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  console.log(`Environment: build=${BUILD_ENV}, production=${environment.production}, apiUrl=${environment.apiUrl}`);
  
  const config: EnvironmentConfig = {
    // API Configuration - from Angular environment
    apiUrl: environment.apiUrl,
    
    // Environment
    production: environment.production,
    
    // Feature Flags
    debugMode: environment.debugMode,
    enableSteam: environment.enableSteam,
    enableReporting: environment.enableReporting,
    
    // Server Configuration
    serverRefreshInterval: environment.serverRefreshInterval,
    pingTimeout: environment.pingTimeout,
    
    // Mod Management
    steamAppId: 221100, // DayZ Steam App ID
    maxConcurrentDownloads: 3,
    
    // Application Settings
    appName: environment.appName,
    enableAutoUpdates: environment.enableAutoUpdates
  };
  
  // Log configuration in debug mode
  if (config.debugMode) {
    console.log('Environment Configuration:', config);
  }
  
  return config;
}

// Export singleton instance
let configInstance: EnvironmentConfig | null = null;

export function getEnvironmentConfig(): EnvironmentConfig {
  if (!configInstance) {
    configInstance = loadEnvironmentConfig();
  }
  return configInstance;
}

// Export for use in IPC handlers
export function getApiUrls(): { apiUrl: string } {
  const config = getEnvironmentConfig();
  return {
    apiUrl: config.apiUrl,
  };
}
