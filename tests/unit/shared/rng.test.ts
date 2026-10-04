import { describe, expect, it } from 'vitest';
import { hashString, mulberry32, sceneSeed, seededShuffle, shuffleUntil } from '@shared/rng.ts';
import { deepFreeze, permutations, sorted } from './helpers.ts';

const take = (next: () => number, n: number): number[] => Array.from({ length: n }, () => next());

describe('hashString (FNV-1a, 32-bit)', () => {
  it('matches the published FNV-1a test vectors', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
    expect(hashString('foobar')).toBe(0xbf9cf968);
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const s of ['scn_taxi02', 'prj_x:1', 'é', '🚀', 'x'.repeat(5000)]) {
      const h = hashString(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });
});

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    expect(take(mulberry32(12345), 50)).toEqual(take(mulberry32(12345), 50));
  });

  it('produces different sequences for different seeds', () => {
    expect(take(mulberry32(1), 10)).not.toEqual(take(mulberry32(2), 10));
  });

  it('yields values in [0, 1)', () => {
    for (const v of take(mulberry32(987654321), 5000)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('treats seeds as unsigned 32-bit values', () => {
    expect(take(mulberry32(-1), 5)).toEqual(take(mulberry32(0xffffffff), 5));
  });
});

describe('sceneSeed', () => {
  it('is stable for the same game seed and scene id', () => {
    expect(sceneSeed(424242, 'scn_taxi02')).toBe(sceneSeed(424242, 'scn_taxi02'));
  });

  it('differs between scene ids of one game', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `scn_${i.toString(36)}`);
    const seeds = new Set(ids.map((id) => sceneSeed(424242, id)));
    expect(seeds.size).toBe(ids.length);
    expect(sceneSeed(424242, 'scn_taxi02')).not.toBe(sceneSeed(424242, 'scn_hangar04'));
  });

  it('differs between game seeds and salts', () => {
    expect(sceneSeed(1, 'scn_a')).not.toBe(sceneSeed(2, 'scn_a'));
    expect(sceneSeed(1, 'scn_a', 0)).not.toBe(sceneSeed(1, 'scn_a', 1));
    expect(sceneSeed(1, 'scn_a')).toBe(sceneSeed(1, 'scn_a', 0));
  });

  it('returns an unsigned 32-bit integer for any valid game seed', () => {
    for (const seed of [0, 1, 424242, 2 ** 31 - 1]) {
      const s = sceneSeed(seed, 'scn_x');
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(2 ** 32);
    }
  });
});

describe('seededShuffle', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

  it('gives the same order for the same seed', () => {
    for (const seed of [0, 1, 99, 2 ** 31 - 1, 0xfffffffe]) {
      expect(seededShuffle(items, seed)).toEqual(seededShuffle(items, seed));
    }
  });

  it('always returns a permutation of the input', () => {
    for (let seed = 0; seed < 500; seed++) {
      expect(sorted(seededShuffle(items, seed))).toEqual(items);
    }
    expect(seededShuffle([], 5)).toEqual([]);
    expect(seededShuffle(['solo'], 5)).toEqual(['solo']);
  });

  it('keeps duplicates and object identity', () => {
    const objs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = seededShuffle(objs, 7);
    expect(out).toHaveLength(3);
    for (const o of objs) expect(out).toContain(o);
    expect(sorted(seededShuffle(['x', 'x', 'y'], 3))).toEqual(['x', 'x', 'y']);
  });

  it('does not mutate its input', () => {
    const frozen = deepFreeze(items.slice());
    expect(() => seededShuffle(frozen, 42)).not.toThrow();
    expect(frozen).toEqual(items);
  });

  it('different seeds give different orders', () => {
    const orders = new Set(Array.from({ length: 50 }, (_, seed) => seededShuffle(items, seed).join('')));
    expect(orders.size).toBeGreaterThan(45);
  });

  it('reaches every permutation of four items (no structural bias)', () => {
    const seen = new Map<string, number>();
    for (let seed = 0; seed < 4800; seed++) {
      const key = seededShuffle(['a', 'b', 'c', 'd'], seed).join('');
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect(seen.size).toBe(24);
    for (const count of seen.values()) {
      expect(count).toBeGreaterThan(100); // expected 200 each
      expect(count).toBeLessThan(300);
    }
  });
});

describe('shuffleUntil', () => {
  const items = [1, 2, 3, 4];

  it('returns the first acceptable seeded candidate, deterministically', () => {
    const accept = (arr: number[]) => arr[0] === 4;
    const a = shuffleUntil(items, 77, accept);
    expect(a[0]).toBe(4);
    expect(shuffleUntil(items, 77, accept)).toEqual(a);
    expect(sorted(a)).toEqual(items);
  });

  it('returns the very first shuffle when it is already acceptable', () => {
    expect(shuffleUntil(items, 5, () => true)).toEqual(seededShuffle(items, 5));
  });

  it('falls back to a rotation when no shuffle is acceptable', () => {
    const rotatedBy2 = [3, 4, 1, 2];
    const accept = (arr: number[]) => arr.join() === rotatedBy2.join();
    expect(shuffleUntil(items, 5, accept, 0)).toEqual(rotatedBy2);
  });

  it('falls back to a copy of the original order when nothing is acceptable', () => {
    const out = shuffleUntil(items, 5, () => false);
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });

  it('only ever proposes permutations of the input', () => {
    const proposals: number[][] = [];
    shuffleUntil(items, 3, (arr) => {
      proposals.push(arr.slice());
      return false;
    });
    const valid = new Set(permutations(items).map((p) => p.join()));
    expect(proposals.length).toBeGreaterThan(24);
    for (const p of proposals) expect(valid.has(p.join())).toBe(true);
  });
});
