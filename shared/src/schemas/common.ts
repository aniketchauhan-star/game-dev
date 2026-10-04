import { z } from 'zod';

/** Prefixes for persisted identifiers. IDs are opaque; the prefix only aids debugging. */
export const ID_PREFIX = {
  project: 'prj',
  document: 'doc',
  slide: 'sld',
  asset: 'ast',
  analysis: 'lan',
  blueprint: 'bpr',
  scene: 'scn',
  version: 'ver',
  job: 'job',
  proposal: 'chg',
  message: 'msg',
  export: 'exp',
  slideEdit: 'sed',
  branch: 'brn',
  gradeProfile: 'grd',
  gradePlan: 'gpl',
  motionPlan: 'mpl',
  designImport: 'dim',
  designFrame: 'dfr',
  screenMap: 'smp',
} as const;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Random, URL-safe identifier with a readable prefix (e.g. `prj_3fK9aQ2LmX0p`). */
export function newId(prefix: string, length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const idString = z.string().regex(/^[a-z]{2,5}_[A-Za-z0-9]{6,32}$/, 'Invalid identifier');

/** Identifiers local to a scene (items, targets, landmarks). */
export const localId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'Use lowercase letters, digits, - or _');

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #RRGGBB color');

export const isoDate = z.string().min(10).max(40);

/** Trimmed, single-paragraph text with a hard length limit (protects layouts). */
export const shortText = (max: number) => z.string().trim().max(max);
export const requiredText = (max: number) => z.string().trim().min(1, 'Required').max(max);

export const provenance = z.enum(['creator', 'claude', 'demo', 'extracted', 'system']);
export type Provenance = z.infer<typeof provenance>;

export const mechanicId = z.enum(['coordinate-navigation', 'drag-match', 'sequence-sort', 'custom']);
export type MechanicId = z.infer<typeof mechanicId>;

export const learningPattern = z.enum(['discover', 'manipulate', 'predict', 'test', 'apply']);
export type LearningPattern = z.infer<typeof learningPattern>;

export const difficulty = z.enum(['gentle', 'standard', 'challenging']);
export type Difficulty = z.infer<typeof difficulty>;
