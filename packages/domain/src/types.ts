export const SOURCES = ['ebay', 'kleinanzeigen', 'facebook'] as const;
export type Source = typeof SOURCES[number];
export type OfferType = 'FIXED_PRICE' | 'AUCTION' | 'OTHER';
export type Health = 'working' | 'defect' | 'unknown' | 'excluded';

export interface ListingText { title?: string | null; description?: string | null; condition?: string | null }

/** Provider-neutral listing produced by every adapter. publishedAt stays null when the source has none. */
export interface NormalizedListing {
  source: Source; externalId: string; title: string; description: string; url: string; imageUrl: string | null;
  priceEur: number; shippingEur: number | null; condition: string; publishedAt: string | null;
  offerType?: OfferType; auctionEndsAt?: string | null; bidCount?: number | null;
}

export interface ScoredListing extends ListingText {
  priceEur?: unknown; shippingEur?: unknown; publishedAt?: string | null; firstSeenAt?: string | null;
  offerType?: string | null; auctionEndsAt?: string | null; bidCount?: number | null;
}

export interface WatchRules {
  query: string; maxWorking?: number | null; maxDefect?: number | null; expectedResale?: number | null;
  repairBudget?: number | null; allowUnknownShipping?: boolean;
}
