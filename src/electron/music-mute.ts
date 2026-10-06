import { EventEmitter } from 'events';
import Store from 'electron-store';

/**
 * The launcher-wide "mute music" switch, shared by everything that can flip it: the
 * speaker button in the title bar and Settings (renderer, through save-settings), and
 * the Windows taskbar thumbnail button and tray menu (main process). One copy of the
 * state, persisted, so the splash's intro honours it before the renderer even runs.
 *
 * `change` fires with (muted, source) only when the value actually changes, so the
 * renderer echoing back a value the main process just sent it is a no-op.
 */
const store = new Store();
const events = new EventEmitter();
let muted = store.get('settings.musicMuted', false) === true;

export type MuteSource = 'renderer' | 'main';

export function isMusicMuted(): boolean {
  return muted;
}

export function setMusicMuted(value: boolean, source: MuteSource): void {
  if (value === muted) return;
  muted = value;
  store.set('settings.musicMuted', value);
  events.emit('change', value, source);
}

export function onMusicMutedChange(listener: (muted: boolean, source: MuteSource) => void): void {
  events.on('change', listener);
}
