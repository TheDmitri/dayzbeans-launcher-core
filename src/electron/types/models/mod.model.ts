export interface DayZMod {
  id: number;
  workshopId: number;
  name: string;
  description?: string;
  iconUrl?: string;
  previewUrl?: string;
  fileSize?: number;
  version?: string;
  isRequired: boolean;
  isSubscribed: boolean;
  isDownloaded: boolean;
  downloadProgress?: number;
  lastUpdated?: string;
  author?: string;
  tags?: string[];
  rating?: number;
  subscriberCount?: number;
}

export interface ModDetails extends DayZMod {
  // Steam API specific fields
  creator?: string;
  creatorAppId?: number;
  consumerAppId?: number;
  timeCreated?: string;
  timeUpdated?: string;
  lastFetched?: string;
  visibility?: number;
  banned?: boolean;
  banReason?: string;

  // Statistics
  subscriptions?: number;
  favorited?: number;
  lifetimeSubscriptions?: number;
  lifetimeFavorited?: number;
  views?: number;

  // Server usage
  serverCount?: number;
}

export interface ModSubscriptionStatus {
  workshopId: number;
  isSubscribed: boolean;
  isDownloaded: boolean;
  downloadProgress?: number;
  installPath?: string;
  lastUpdated?: string;
}

export interface ModDownloadRequest {
  workshopId: number;
  name: string;
  autoSubscribe?: boolean;
}

export interface ModSearchFilter {
  searchTerm?: string;
  tags?: string[];
  sortBy?: 'name' | 'rating' | 'subscribers' | 'updated';
  sortDirection?: 'asc' | 'desc';
}

export interface SteamWorkshopItem {
  publishedfileid: string;
  title: string;
  description: string;
  preview_url: string;
  file_size: number;
  time_created: number;
  time_updated: number;
  creator: string;
  tags: Array<{
    tag: string;
  }>;
  subscriptions: number;
  favorited: number;
  lifetime_subscriptions: number;
}
