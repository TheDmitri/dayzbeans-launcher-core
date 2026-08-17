/**
 * Discord Rich Presence Service
 * Manages Discord RPC connection and presence updates for DayZ Beans Launcher
 */

import { Client } from '@xhayper/discord-rpc';
import Store from 'electron-store';

const store = new Store();

// Discord Application ID - You need to create an application at https://discord.com/developers/applications
const DISCORD_CLIENT_ID = '1443203144690438164';

// Launcher website URL
const LAUNCHER_URL = 'https://dayzbeanslauncher.com';

// Presence state types
export type PresenceState = 
  | 'browsing'      // Browsing servers
  | 'viewing'       // Viewing a specific server
  | 'connecting'    // Connecting to server
  | 'downloading'   // Downloading mods
  | 'playing'       // Playing DayZ
  | 'mods';         // Managing mods

export interface PresenceData {
  state: PresenceState;
  serverName?: string;
  serverIp?: string;
  serverPort?: number;
  playerCount?: number;
  maxPlayers?: number;
  modCount?: number;
  downloadProgress?: number;
  isPremiumServer?: boolean; // Premium/promoted servers get their name as the main title
}

class DiscordService {
  private client: Client | null = null;
  private isConnected = false;
  private isConnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private startTimestamp: number = Date.now();
  private currentPresence: PresenceData = { state: 'browsing' };

  constructor() {
    this.client = new Client({ clientId: DISCORD_CLIENT_ID });
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on('ready', () => {
      console.log('✅ Discord RPC connected');
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.startTimestamp = Date.now();
      
      // Set initial presence
      this.updatePresence(this.currentPresence);
    });

    this.client.on('disconnected', () => {
      console.log('⚠️ Discord RPC disconnected');
      this.isConnected = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('❌ Max Discord reconnect attempts reached');
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      console.log(`🔄 Discord RPC reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
      this.connect();
    }, this.reconnectDelay);
  }

  /**
   * Initialize and connect to Discord RPC
   */
  async connect(): Promise<boolean> {
    if (this.isConnected || this.isConnecting) {
      return this.isConnected;
    }

    if (!this.client) {
      this.client = new Client({ clientId: DISCORD_CLIENT_ID });
      this.setupEventHandlers();
    }

    this.isConnecting = true;

    try {
      console.log('🔌 Connecting to Discord RPC...');
      await this.client.login();
      return true;
    } catch (error) {
      console.log('⚠️ Discord RPC connection failed (Discord may not be running):', error);
      this.isConnecting = false;
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Disconnect from Discord RPC
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.client && this.isConnected) {
      try {
        await this.client.destroy();
        console.log('🔌 Discord RPC disconnected');
      } catch (error) {
        console.error('Error disconnecting Discord RPC:', error);
      }
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.client = null;
  }

  /**
   * Update Discord Rich Presence
   */
  async updatePresence(data: PresenceData): Promise<boolean> {
    this.currentPresence = data;

    if (!this.isConnected || !this.client) {
      console.log('⚠️ Discord not connected, cannot update presence');
      return false;
    }

    try {
      const presence = this.buildPresence(data);
      console.log('🎮 Setting Discord presence:', JSON.stringify(presence, null, 2));
      await this.client.user?.setActivity(presence);
      console.log(`✅ Discord presence updated: ${data.state}`);
      return true;
    } catch (error) {
      console.error('❌ Error updating Discord presence:', error);
      return false;
    }
  }

  /**
   * Build presence object based on state
   */
  private buildPresence(data: PresenceData): any {
    // Privacy: when enabled, keep the generic launcher status but hide WHICH server
    // the user is on (no server name in title/details/state, no Join button with IP:port).
    const hideServer = store.get('settings.hideDiscordServerDetails') === true;

    // Build buttons array - always include launcher button
    const buttons: Array<{ label: string; url: string }> = [];

    // Add "Join Server" button if we have server info (for viewing, connecting, playing states)
    // Suppressed when the user opted to hide server details (the URL embeds the exact IP:port).
    if (!hideServer && data.serverIp && data.serverPort && ['viewing', 'connecting', 'playing'].includes(data.state)) {
      buttons.push({
        label: 'Join Server',
        url: `dayzbeans://server/connect/${data.serverIp}:${data.serverPort}`,
      });
    }

    // Always add the launcher download button
    buttons.push({
      label: 'Get DayZ Beans Launcher',
      url: LAUNCHER_URL,
    });

    // For premium servers, show server name as main title (largeImageText).
    // Force off when hiding server details so the name is never used as the title.
    const isPremium = !hideServer && data.isPremiumServer && data.serverName;
    
    const basePresence: any = {
      largeImageKey: 'dayz_beans_launcher',
      largeImageText: isPremium ? this.truncate(data.serverName!, 128) : 'DayZ Beans Launcher',
      smallImageKey: 'dayz_icon',
      smallImageText: isPremium ? 'via DayZ Beans Launcher' : 'DayZ',
      instance: false,
      buttons,
    };

    switch (data.state) {
      case 'browsing':
        return {
          ...basePresence,
          details: 'Browsing Servers',
          state: 'Looking for a server to join',
          startTimestamp: this.startTimestamp,
        };

      case 'viewing':
        // Premium servers: show "Viewing Server" as details since server name is in title
        // Regular servers: show server name in details
        return {
          ...basePresence,
          details: (isPremium || hideServer) ? 'Viewing Server' : (data.serverName ? `Viewing: ${this.truncate(data.serverName, 50)}` : 'Viewing Server'),
          state: data.playerCount !== undefined && data.maxPlayers !== undefined
            ? `${data.playerCount}/${data.maxPlayers} players`
            : 'Checking server info',
          startTimestamp: this.startTimestamp,
        };

      case 'connecting':
        return {
          ...basePresence,
          details: (isPremium || hideServer) ? 'Connecting...' : 'Connecting to Server',
          state: (isPremium || hideServer) ? 'Preparing to join' : (data.serverName ? this.truncate(data.serverName, 50) : 'Preparing to join...'),
          startTimestamp: Date.now(),
        };

      case 'downloading':
        return {
          ...basePresence,
          details: 'Downloading Mods',
          state: data.downloadProgress !== undefined
            ? `Progress: ${data.downloadProgress}%`
            : data.modCount !== undefined
              ? `${data.modCount} mods to download`
              : 'Preparing downloads...',
          startTimestamp: Date.now(),
        };

      case 'playing':
        // Premium servers: show "Playing DayZ" as details since server name is in title
        // Regular servers: show server name in state
        return {
          ...basePresence,
          details: 'Playing DayZ',
          state: (isPremium || hideServer)
            ? (data.playerCount !== undefined && data.maxPlayers !== undefined
                ? `${data.playerCount}/${data.maxPlayers} players`
                : 'In-game')
            : (data.serverName ? this.truncate(data.serverName, 50) : 'In-game'),
          startTimestamp: Date.now(),
        };

      case 'mods':
        return {
          ...basePresence,
          details: 'Managing Mods',
          state: data.modCount !== undefined
            ? `${data.modCount} mods subscribed`
            : 'Browsing Workshop',
          startTimestamp: this.startTimestamp,
        };

      default:
        return {
          ...basePresence,
          details: 'DayZ Beans Launcher',
          state: 'Idle',
          startTimestamp: this.startTimestamp,
        };
    }
  }

  /**
   * Truncate string to max length
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }

  /**
   * Clear presence (show as idle)
   */
  async clearPresence(): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      return false;
    }

    try {
      await this.client.user?.clearActivity();
      console.log('🎮 Discord presence cleared');
      return true;
    } catch (error) {
      console.error('Error clearing Discord presence:', error);
      return false;
    }
  }

  /**
   * Check if connected to Discord
   */
  isDiscordConnected(): boolean {
    return this.isConnected;
  }

  // Convenience methods for common presence states

  async setBrowsingServers(): Promise<boolean> {
    return this.updatePresence({ state: 'browsing' });
  }

  async setViewingServer(serverName: string, serverIp?: string, serverPort?: number, playerCount?: number, maxPlayers?: number, isPremiumServer?: boolean): Promise<boolean> {
    return this.updatePresence({
      state: 'viewing',
      serverName,
      serverIp,
      serverPort,
      playerCount,
      maxPlayers,
      isPremiumServer,
    });
  }

  async setConnecting(serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean): Promise<boolean> {
    return this.updatePresence({
      state: 'connecting',
      serverName,
      serverIp,
      serverPort,
      isPremiumServer,
    });
  }

  async setDownloading(modCount?: number, downloadProgress?: number, serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean): Promise<boolean> {
    return this.updatePresence({
      state: 'downloading',
      modCount,
      downloadProgress,
      serverName,
      serverIp,
      serverPort,
      isPremiumServer,
    });
  }

  async setPlaying(serverName?: string, serverIp?: string, serverPort?: number, isPremiumServer?: boolean, playerCount?: number, maxPlayers?: number): Promise<boolean> {
    return this.updatePresence({
      state: 'playing',
      serverName,
      serverIp,
      serverPort,
      isPremiumServer,
      playerCount,
      maxPlayers,
    });
  }

  async setManagingMods(modCount?: number): Promise<boolean> {
    return this.updatePresence({
      state: 'mods',
      modCount,
    });
  }
}

// Singleton instance
export const discordService = new DiscordService();
