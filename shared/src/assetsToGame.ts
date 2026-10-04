import type { Asset } from './schemas/assets.ts';
import { DEFAULT_PLACEMENT, type GameAsset } from './schemas/game.ts';

/**
 * How a library asset is packaged in a game: the validated display file, its
 * type, size, alt text, sprite clips and placement. Used by the compiler and
 * by ops that bring a library asset into an existing version (always computed
 * from the stored asset record, never taken from a request).
 */
export function toGameAsset(a: Asset): GameAsset {
  const mime = (a.kind === 'image' ? (a.format === 'jpeg' && !a.hasAlpha ? 'image/jpeg' : a.format === 'webp' ? 'image/webp' : 'image/png') : a.mime) as GameAsset['mime'];
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : mime === 'audio/mpeg' ? 'mp3' : mime === 'audio/ogg' ? 'ogg' : mime === 'audio/wav' ? 'wav' : 'm4a';
  const alt = (a.metadata.alt || a.name).trim();
  return {
    id: a.id,
    kind: a.kind,
    file: `assets/${a.id}.${ext}`,
    mime,
    width: a.width,
    height: a.height,
    alt: alt.length > 160 ? `${alt.slice(0, 159).trimEnd()}…` : alt,
    sprite: a.metadata.sprite,
    placement: a.metadata.placement ?? DEFAULT_PLACEMENT,
  };
}
