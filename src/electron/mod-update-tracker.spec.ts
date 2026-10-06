import {
  ACKNOWLEDGED_KEY,
  AcknowledgementStore,
  METADATA_ONLY_GRACE_MS,
  REQUEST_EXPIRY_MS,
  RETRIGGER_QUIET_MS,
  acknowledgeTimestamp,
  acknowledgedTimestamp,
  noteDownloadRequested,
  observeState,
  resetModUpdateTracker,
  setAcknowledgementStore,
} from './mod-update-tracker';

describe('mod-update-tracker', () => {
  const ID = '1559212036';
  const idle = { isInstalled: true, isDownloading: false, needsUpdateFlag: false };
  const downloading = { isInstalled: true, isDownloading: true, needsUpdateFlag: false };

  beforeEach(() => resetModUpdateTracker());

  describe('observeState', () => {
    it('calls a request Steam never acted on metadata-only once the grace period is over', () => {
      noteDownloadRequested(ID, 0);
      noteDownloadRequested(ID, RETRIGGER_QUIET_MS); // the wait loop re-asks

      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS - 1)).toBeFalse();
      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS)).toBeTrue();
      // Judged once, then forgotten
      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS + 1000)).toBeFalse();
    });

    it('does not judge a single unanswered request: Steam may have dropped it', () => {
      noteDownloadRequested(ID, 0);

      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS * 2)).toBeFalse();
    });

    it('ignores a re-request made too soon after the first to tell anything', () => {
      noteDownloadRequested(ID, 0);
      noteDownloadRequested(ID, 500); // a second caller asking at the same time

      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS)).toBeFalse();
    });

    it('gives the re-request its own quiet period before judging', () => {
      noteDownloadRequested(ID, 0);
      noteDownloadRequested(ID, METADATA_ONLY_GRACE_MS - 1000); // late retry

      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS)).toBeFalse();
      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS - 1000 + RETRIGGER_QUIET_MS)).toBeTrue();
    });

    it('never calls a dropped download metadata-only once the re-request gets it going', () => {
      noteDownloadRequested(ID, 0);
      observeState(ID, idle, RETRIGGER_QUIET_MS - 1);
      noteDownloadRequested(ID, RETRIGGER_QUIET_MS);

      expect(observeState(ID, downloading, RETRIGGER_QUIET_MS + 2_000)).toBeFalse();
      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS * 2)).toBeFalse();
    });

    it('never calls a real download metadata-only, even after it finishes', () => {
      noteDownloadRequested(ID, 0);

      expect(observeState(ID, downloading, 5_000)).toBeFalse();
      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS + 5_000)).toBeFalse();
    });

    it('treats a queued item (NeedsUpdate set) as activity', () => {
      noteDownloadRequested(ID, 0);

      expect(observeState(ID, { ...idle, needsUpdateFlag: true }, 10_000)).toBeFalse();
      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS * 2)).toBeFalse();
    });

    it('does not restart the grace period when the download is re-triggered', () => {
      noteDownloadRequested(ID, 0);
      observeState(ID, idle, 10_000);
      noteDownloadRequested(ID, 20_000); // re-trigger from a wait loop
      noteDownloadRequested(ID, 30_000);

      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS)).toBeTrue();
    });

    it('forgets a request nobody watched instead of judging it', () => {
      noteDownloadRequested(ID, 0);

      expect(observeState(ID, idle, REQUEST_EXPIRY_MS + 1)).toBeFalse();
    });

    it('ignores items with no pending request', () => {
      expect(observeState(ID, idle, METADATA_ONLY_GRACE_MS * 10)).toBeFalse();
    });

    it('waits while the item is not installed', () => {
      noteDownloadRequested(ID, 0);
      noteDownloadRequested(ID, RETRIGGER_QUIET_MS);

      expect(observeState(ID, { ...idle, isInstalled: false }, METADATA_ONLY_GRACE_MS)).toBeFalse();
    });
  });

  describe('acknowledgements', () => {
    function fakeStore(): AcknowledgementStore & { values: Map<string, unknown> } {
      const values = new Map<string, unknown>();
      return { values, get: key => values.get(key), set: (key, value) => { values.set(key, value); } };
    }

    it('persists an acknowledged version and only moves it forward', () => {
      const store = fakeStore();
      setAcknowledgementStore(store);

      acknowledgeTimestamp(ID, 2000);
      acknowledgeTimestamp(ID, 1000);

      expect(acknowledgedTimestamp(ID)).toBe(2000);
      expect(store.values.get(ACKNOWLEDGED_KEY)).toEqual({ [ID]: 2000 });
    });

    it('reads acknowledgements saved by a previous session', () => {
      const store = fakeStore();
      store.values.set(ACKNOWLEDGED_KEY, { [ID]: 1700000000 });
      setAcknowledgementStore(store);

      expect(acknowledgedTimestamp(ID)).toBe(1700000000);
      expect(acknowledgedTimestamp('other')).toBe(0);
    });

    it('ignores an empty timestamp', () => {
      acknowledgeTimestamp(ID, 0);

      expect(acknowledgedTimestamp(ID)).toBe(0);
    });
  });
});
