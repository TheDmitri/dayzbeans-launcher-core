/**
 * Workshop details for many items through Steam's batched UGC query.
 *
 * `workshop.getItem` is one network query per item, and so is
 * getWorkshopItemDetailsBatch, which only runs those in parallel. `workshop.getItems`
 * asks for up to a page of items in one query, which is what a check over every
 * subscribed mod wants.
 *
 * No Electron import here: the caller hands in `getItems`, which keeps this testable.
 */

/** What freshness checks and progress messages need from an item. */
export interface WorkshopItemSummary {
  title: string;
  timeUpdated: number;
}

/** Steam returns at most this many items per UGC query. */
export const WORKSHOP_QUERY_PAGE_SIZE = 50;

type GetItems = (ids: bigint[]) => Promise<{ items: Array<{ publishedFileId: bigint; title?: string; timeUpdated?: number } | null | undefined> }>;

/**
 * Summaries keyed by workshop id. An item Steam did not return is mapped to an empty
 * summary, the same answer `getItem` gives for it. A page whose query failed leaves its
 * ids out entirely, so the caller can fall back to asking per item.
 */
export async function queryWorkshopItems(getItems: GetItems, ids: string[]): Promise<Map<string, WorkshopItemSummary>> {
  const summaries = new Map<string, WorkshopItemSummary>();

  for (let i = 0; i < ids.length; i += WORKSHOP_QUERY_PAGE_SIZE) {
    const page = ids.slice(i, i + WORKSHOP_QUERY_PAGE_SIZE);
    try {
      const { items } = await getItems(page.map(id => BigInt(id)));
      for (const id of page) {
        summaries.set(id, { title: '', timeUpdated: 0 });
      }
      for (const item of items) {
        if (!item) continue;
        summaries.set(item.publishedFileId.toString(), {
          title: item.title || '',
          timeUpdated: Number(item.timeUpdated) || 0,
        });
      }
    } catch (error) {
      console.warn(`Batched workshop query failed for ${page.length} items:`, (error as Error).message);
    }
  }

  return summaries;
}
