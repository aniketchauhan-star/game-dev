/** Deterministic randomness so a given seed always produces the same game. */

export function hashString(input: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed for one scene: stable for the same game seed and scene id. */
export function sceneSeed(gameSeed: number, sceneId: string, salt = 0): number {
  return (hashString(`${gameSeed}:${sceneId}:${salt}`) ^ gameSeed) >>> 0;
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Shuffle, retrying with derived seeds until `isAcceptable` holds (e.g. a sort
 * puzzle must not start solved). Falls back to a rotation, then the original order.
 */
export function shuffleUntil<T>(items: readonly T[], seed: number, isAcceptable: (arr: T[]) => boolean, attempts = 24): T[] {
  for (let k = 0; k < attempts; k++) {
    const candidate = seededShuffle(items, (seed + k * 7919) >>> 0);
    if (isAcceptable(candidate)) return candidate;
  }
  for (let r = 1; r < items.length; r++) {
    const rotated = [...items.slice(r), ...items.slice(0, r)];
    if (isAcceptable(rotated)) return rotated;
  }
  return items.slice();
}
