/**
 * App Suspension Service
 * 
 * Manages app sleep/wake states to reduce resource usage when minimized.
 * Pauses background tasks, polling, and reduces memory footprint.
 */

import { BrowserWindow, powerMonitor } from 'electron';

export interface SuspensionState {
  isSuspended: boolean;
  suspendedAt: number | null;
  reason: 'minimized' | 'hidden' | 'system_sleep' | null;
}

let mainWindow: BrowserWindow | null = null;
let suspensionState: SuspensionState = {
  isSuspended: false,
  suspendedAt: null,
  reason: null
};

// Callbacks for suspension events
const suspendCallbacks: Array<() => void> = [];
const resumeCallbacks: Array<() => void> = [];

/**
 * Initialize the suspension service with the main window
 */
export function initSuspensionService(window: BrowserWindow): void {
  mainWindow = window;
  
  // Window minimize/restore events
  window.on('minimize', () => {
    console.log('📉 Window minimized - suspending app...');
    suspendApp('minimized');
  });
  
  window.on('restore', () => {
    console.log('📈 Window restored - resuming app...');
    resumeApp();
  });
  
  window.on('hide', () => {
    console.log('👁️ Window hidden - suspending app...');
    suspendApp('hidden');
  });
  
  window.on('show', () => {
    if (suspensionState.isSuspended && suspensionState.reason === 'hidden') {
      console.log('👁️ Window shown - resuming app...');
      resumeApp();
    }
  });
  
  // Focus/blur for additional optimization (optional - less aggressive)
  window.on('blur', () => {
    // Don't suspend on blur, just log
    console.log('🔇 Window lost focus');
  });
  
  window.on('focus', () => {
    console.log('🔊 Window gained focus');
    // If suspended for other reasons, resume on focus
    if (suspensionState.isSuspended) {
      resumeApp();
    }
  });
  
  // System power events
  powerMonitor.on('suspend', () => {
    console.log('💤 System going to sleep - suspending app...');
    suspendApp('system_sleep');
  });
  
  powerMonitor.on('resume', () => {
    console.log('☀️ System waking up - resuming app...');
    resumeApp();
  });
  
  // Lock screen events (optional)
  powerMonitor.on('lock-screen', () => {
    console.log('🔒 Screen locked - suspending app...');
    suspendApp('hidden');
  });
  
  powerMonitor.on('unlock-screen', () => {
    console.log('🔓 Screen unlocked - resuming app...');
    resumeApp();
  });
  
  console.log('✅ App suspension service initialized');
}

/**
 * Suspend the app - pause all background activities
 */
function suspendApp(reason: SuspensionState['reason']): void {
  if (suspensionState.isSuspended) {
    return; // Already suspended
  }
  
  suspensionState = {
    isSuspended: true,
    suspendedAt: Date.now(),
    reason
  };
  
  // Notify renderer process
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-suspended', { reason });
  }
  
  // Execute all suspend callbacks
  suspendCallbacks.forEach(callback => {
    try {
      callback();
    } catch (error) {
      console.error('Error in suspend callback:', error);
    }
  });
  
  // NOTE: We intentionally do NOT call setBackgroundThrottling(true) here.
  // Throttling the renderer while backgrounded can leave the window blank or
  // frozen when it is restored. CPU is saved by the suspend callbacks above
  // (which pause polling); rendering must stay responsive.

  console.log(`⏸️ App suspended (reason: ${reason})`);
}

/**
 * Resume the app - restart background activities
 */
function resumeApp(): void {
  if (!suspensionState.isSuspended) {
    return; // Not suspended
  }
  
  const suspendedDuration = suspensionState.suspendedAt 
    ? Math.round((Date.now() - suspensionState.suspendedAt) / 1000)
    : 0;
  
  suspensionState = {
    isSuspended: false,
    suspendedAt: null,
    reason: null
  };
  
  // Re-enable rendering and force a repaint. Without this the renderer can
  // stay throttled after being suspended in the background, leaving the
  // window blank/frozen when the user brings it back to the foreground.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setBackgroundThrottling(false);
    mainWindow.webContents.invalidate();
  }

  // Notify renderer process
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-resumed', { suspendedDuration });
  }

  // Execute all resume callbacks
  resumeCallbacks.forEach(callback => {
    try {
      callback();
    } catch (error) {
      console.error('Error in resume callback:', error);
    }
  });
  
  console.log(`▶️ App resumed (was suspended for ${suspendedDuration}s)`);
}

/**
 * Register a callback to be called when app is suspended
 */
export function onSuspend(callback: () => void): void {
  suspendCallbacks.push(callback);
}

/**
 * Register a callback to be called when app is resumed
 */
export function onResume(callback: () => void): void {
  resumeCallbacks.push(callback);
}

/**
 * Check if app is currently suspended
 */
export function isAppSuspended(): boolean {
  return suspensionState.isSuspended;
}

/**
 * Get current suspension state
 */
export function getSuspensionState(): SuspensionState {
  return { ...suspensionState };
}

/**
 * Manually suspend the app (e.g., when game is launched)
 */
export function manualSuspend(reason: string = 'manual'): void {
  console.log(`🎮 Manual suspend requested: ${reason}`);
  suspendApp('hidden');
}

/**
 * Manually resume the app
 */
export function manualResume(): void {
  console.log('🎮 Manual resume requested');
  resumeApp();
}
