import { WORKSHOP_QUERY_PAGE_SIZE, queryWorkshopItems } from './workshop-items';

describe('queryWorkshopItems', () => {
  const item = (id: string, timeUpdated: number) => ({ publishedFileId: BigInt(id), title: `Mod ${id}`, timeUpdated });

  it('asks Steam once per page of ids, not once per item', async () => {
    const ids = Array.from({ length: WORKSHOP_QUERY_PAGE_SIZE + 3 }, (_, i) => String(1000 + i));
    const getItems = jasmine.createSpy('getItems').and.callFake(async (page: bigint[]) => ({
      items: page.map(id => item(id.toString(), 1700000000)),
    }));

    const summaries = await queryWorkshopItems(getItems, ids);

    expect(getItems).toHaveBeenCalledTimes(2);
    expect(summaries.size).toBe(ids.length);
    expect(summaries.get('1002')).toEqual({ title: 'Mod 1002', timeUpdated: 1700000000 });
  });

  it('keys by the id Steam returned, whatever the order', async () => {
    const getItems = async () => ({ items: [item('2', 200), null, item('1', 100)] });

    const summaries = await queryWorkshopItems(getItems, ['1', '2', '3']);

    expect(summaries.get('1')?.timeUpdated).toBe(100);
    expect(summaries.get('2')?.timeUpdated).toBe(200);
    // Not returned: the same empty answer getItem gives for a missing item
    expect(summaries.get('3')).toEqual({ title: '', timeUpdated: 0 });
  });

  it('leaves the ids of a failed page out so the caller can ask per item', async () => {
    const getItems = async () => { throw new Error('offline'); };

    const summaries = await queryWorkshopItems(getItems, ['1', '2']);

    expect(summaries.size).toBe(0);
  });
});
