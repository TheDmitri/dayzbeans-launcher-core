import { DayZMod } from "./mod.model";

export interface DayZServer {
  // Backend ServerDTO fields
  id: number;
  name: string;
  ip: string;
  port: number;
  queryPort: number;
  map: string;
  playerCount: number;
  maxPlayers: number;
  isOnline: boolean;
  lastSeen: string; // ISO date string from backend
  thirdPerson: boolean;
  version?: string;
  gameTime?: string;
  mods: DayZMod[];
  lastModSync?: string; // ISO date string from backend
  isPromoted?: boolean; // For UI promoted/sponsored servers
  password?: string; // Optional password for server connection
  
  // Owner-editable fields
  description?: string; // Server description
  trailerUrl?: string; // YouTube trailer URL
  bannerUrl?: string; // Background/banner image URL
  discordUrl?: string; // Discord server invite link
  websiteUrl?: string; // Server website URL
}

export interface ServerFilter {
  map?: string;
  search?: string;
  onlineOnly?: boolean;
  minPlayers?: number;
  maxPlayers?: number;
}

export interface ServerSort {
  field: 'name' | 'players' | 'ping' | 'map';
  direction: 'asc' | 'desc';
}
