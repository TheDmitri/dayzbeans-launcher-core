import { DayZQueryTargetSchema, DayZServerProbeSchema, DiscoverOptionsSchema, ServerDataSchema } from './ipc-schemas';

describe('ipc-schemas', () => {
  // z.object drops undeclared keys without a word. Losing `edition` here would launch the
  // stable client for every Experimental server.
  it('keeps the game edition on join requests', () => {
    const parsed = ServerDataSchema.parse({ ip: '10.0.0.1', port: 2302, edition: 'experimental' });
    expect(parsed.edition).toBe('experimental');
  });

  it('rejects an unknown edition rather than guessing', () => {
    expect(ServerDataSchema.safeParse({ ip: '10.0.0.1', port: 2302, edition: 'beta' }).success).toBeFalse();
  });

  describe('Direct Connect', () => {
    it('keeps the local server key on join requests and accepts only an opaque key, never a path', () => {
      const key = '0123456789abcdef0123456789abcdef';
      expect(ServerDataSchema.parse({ ip: '127.0.0.1', port: 2302, localServerKey: key }).localServerKey).toBe(key);
      for (const bad of ['C:\\DayZServer\\@jp_client', '../../etc', key.toUpperCase(), key + '0']) {
        expect(ServerDataSchema.safeParse({ ip: '127.0.0.1', port: 2302, localServerKey: bad }).success).withContext(bad).toBeFalse();
      }
    });

    it('caps the join host like every other host', () => {
      expect(ServerDataSchema.safeParse({ ip: 'a'.repeat(256), port: 2302 }).success).toBeFalse();
    });

    it('lets discovery take nothing but the LAN switch', () => {
      expect(DiscoverOptionsSchema.safeParse({ lan: true }).success).toBeTrue();
      expect(DiscoverOptionsSchema.safeParse({ lan: true, hosts: ['10.0.0.0/8'] }).success).toBeFalse();
      expect(DiscoverOptionsSchema.safeParse({}).success).toBeFalse();
    });

    it('takes one host and one game port for a lookup, no port list', () => {
      expect(DayZQueryTargetSchema.safeParse({ host: 'play.example.net', gamePort: 2302, queryPortHint: 2303 }).success).toBeTrue();
      expect(DayZQueryTargetSchema.safeParse({ host: '203.0.113.5', gamePort: 2302, ports: [1, 2, 3] }).success).toBeFalse();
      expect(DayZQueryTargetSchema.safeParse({ host: '10.0.0.1;rm -rf', gamePort: 2302 }).success).toBeFalse();
      expect(DayZQueryTargetSchema.safeParse({ host: '10.0.0.1', gamePort: 0 }).success).toBeFalse();
    });

    it('checks what a probe may carry back to the renderer', () => {
      const probe = {
        ip: '127.0.0.1', gamePort: 2302, queryPort: 2305, source: 'process', online: true, name: 'Local', map: 'sakhal',
        players: 0, maxPlayers: 10, version: '1.30.164014', appId: 1024020, edition: 'experimental', passwordProtected: true,
        firstPerson: false, pingMs: 0, mods: [{ workshopId: 1559212036, name: 'CF' }], unpublishedMods: [{ name: 'jp_client' }],
        modsSource: 'rules', modsComplete: true, localServerKey: '0123456789abcdef0123456789abcdef',
      };
      expect(DayZServerProbeSchema.safeParse(probe).success).toBeTrue();
      expect(DayZServerProbeSchema.safeParse({ ...probe, mods: [{ workshopId: 0, name: 'x' }] }).success).toBeFalse();
      expect(DayZServerProbeSchema.safeParse({ ...probe, name: 'x'.repeat(300) }).success).toBeFalse();
    });
  });
});
