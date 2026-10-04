import { z } from 'zod';
import { shortText } from './common.ts';
import { motionProfile } from './motion.ts';

/**
 * Who the game is for. Grade supplies starting suggestions only: difficulty,
 * reading support, guidance and motion are separate settings the creator
 * controls. Nothing here infers a learner's age, ability, diagnosis or reading
 * level, and curriculum alignment is never claimed as verified.
 */

export const gradeValue = z.union([z.number().int().min(1).max(12), z.literal('custom')]);
export type GradeValue = z.infer<typeof gradeValue>;

export const gradeProfileSchema = z.object({
  grade: gradeValue,
  /** Label when grade is custom, e.g. "Adult learners". */
  customLabel: shortText(40),
  /** Optional curriculum or board name — recorded, never verified. */
  curriculum: shortText(80),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  prerequisites: shortText(400),
  lessonMinutes: z.number().int().min(1).max(180).nullable(),
  inputDevice: z.enum(['mixed', 'mouse', 'touch', 'keyboard', 'whiteboard']),
  /** Instructional difficulty. */
  difficulty: z.enum(['foundational', 'core', 'stretch']),
  /** How much the text supports reading (length, key terms, step lists) — not a reading level. */
  readingSupport: z.enum(['standard', 'supported', 'extended']),
  guidance: z.enum(['minimal', 'standard', 'extra']),
  motion: z.object({
    profile: motionProfile,
    pacing: z.enum(['calm', 'standard']),
    decorativeIntensity: z.enum(['off', 'low', 'standard']),
    sound: z.boolean(),
  }),
  access: z.object({
    lowMotion: z.boolean(),
    untimed: z.boolean(),
    keyboard: z.boolean(),
    extraGuidance: z.boolean(),
  }),
  /** The product preset that seeded these values (null when set entirely by hand). */
  presetId: z.enum(['g1-2', 'g3-5', 'g6-8', 'g9-12']).nullable(),
});
export type GradeProfile = z.infer<typeof gradeProfileSchema>;

export const gradeProfileRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branchId: z.string(),
  revision: z.number().int(),
  origin: z.enum(['creator', 'preset', 'branch']),
  profile: gradeProfileSchema,
  createdAt: z.string(),
});
export type GradeProfileRecord = z.infer<typeof gradeProfileRecordSchema>;

export type GradePresetId = NonNullable<GradeProfile['presetId']>;

export interface GradePreset {
  id: GradePresetId;
  label: string;
  grades: number[];
  /** What the preset suggests, in plain words (product guidance, not research). */
  summary: string[];
  values: Pick<GradeProfile, 'difficulty' | 'readingSupport' | 'guidance' | 'motion'>;
}

export const PRESET_DISCLAIMER = 'Product presets — starting suggestions you can change, not scientifically validated grade rules.';

export const GRADE_PRESETS: Record<GradePresetId, GradePreset> = {
  'g1-2': {
    id: 'g1-2',
    label: 'Grades 1–2',
    grades: [1, 2],
    summary: ['One main action at a time', 'Concise instructions', 'Prominent controls', 'A guided example first', 'Restrained, friendly feedback'],
    values: { difficulty: 'foundational', readingSupport: 'extended', guidance: 'extra', motion: { profile: 'guided', pacing: 'calm', decorativeIntensity: 'low', sound: true } },
  },
  'g3-5': {
    id: 'g3-5',
    label: 'Grades 3–5',
    grades: [3, 4, 5],
    summary: ['Short task sequences', 'Visible progress', 'Optional hints', 'Purposeful object movement'],
    values: { difficulty: 'core', readingSupport: 'supported', guidance: 'standard', motion: { profile: 'guided', pacing: 'standard', decorativeIntensity: 'low', sound: true } },
  },
  'g6-8': {
    id: 'g6-8',
    label: 'Grades 6–8',
    grades: [6, 7, 8],
    summary: ['Discovery and challenge framing', 'Progressive reasoning', 'Cleaner instruction panels', 'Motion that explains relationships'],
    values: { difficulty: 'core', readingSupport: 'standard', guidance: 'standard', motion: { profile: 'guided', pacing: 'standard', decorativeIntensity: 'low', sound: true } },
  },
  'g9-12': {
    id: 'g9-12',
    label: 'Grades 9–12',
    grades: [9, 10, 11, 12],
    summary: ['Precise terminology', 'Multi-step reasoning where the source supports it', 'Compact, polished feedback', 'Optional minimal decorative motion'],
    values: { difficulty: 'stretch', readingSupport: 'standard', guidance: 'minimal', motion: { profile: 'minimal', pacing: 'standard', decorativeIntensity: 'off', sound: true } },
  },
};

export function presetForGrade(grade: GradeValue): GradePreset | null {
  if (grade === 'custom') return null;
  return Object.values(GRADE_PRESETS).find((p) => p.grades.includes(grade)) ?? null;
}

export function gradeLabel(p: Pick<GradeProfile, 'grade' | 'customLabel'>): string {
  return p.grade === 'custom' ? p.customLabel.trim() || 'Custom group' : `Grade ${p.grade}`;
}

export const DEFAULT_ACCESS: GradeProfile['access'] = { lowMotion: false, untimed: true, keyboard: true, extraGuidance: false };

/** A starting profile for a grade, seeded from its product preset. */
export function profileForGrade(grade: GradeValue, base?: Partial<GradeProfile>): GradeProfile {
  const preset = presetForGrade(grade);
  const values = preset?.values ?? GRADE_PRESETS['g6-8'].values;
  return {
    grade,
    customLabel: base?.customLabel ?? '',
    curriculum: base?.curriculum ?? '',
    language: base?.language ?? 'en',
    prerequisites: base?.prerequisites ?? '',
    lessonMinutes: base?.lessonMinutes ?? null,
    inputDevice: base?.inputDevice ?? 'mixed',
    difficulty: values.difficulty,
    readingSupport: values.readingSupport,
    guidance: values.guidance,
    motion: { ...values.motion },
    access: base?.access ?? { ...DEFAULT_ACCESS },
    presetId: preset?.id ?? null,
  };
}

// ───────────── Grade Adaptation Plan ─────────────

export const adaptationArea = z.enum(['language', 'task-steps', 'difficulty', 'hints', 'feedback', 'motion', 'layout']);

/** Fields a presentation-only change may touch: copy and guidance, never outcomes or answer rules. */
export const PRESENTATION_FIELDS = ['title', 'instruction', 'supportText', 'feedback.success', 'feedback.error', 'feedback.hints', 'layout.density', 'layout.showProgress'] as const;
export const presentationField = z.enum(PRESENTATION_FIELDS);

export const adaptationItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  area: adaptationArea,
  /** Scene the change applies to, or null for the whole game. */
  sceneId: z.string().max(40).nullable(),
  /** A concrete presentation change, when the item has one. */
  change: z
    .object({
      field: presentationField,
      value: z.union([z.string().max(400), z.array(z.string().max(160)).max(3), z.boolean(), z.enum(['comfortable', 'compact'])]),
    })
    .nullable(),
  summary: z.string().trim().min(1).max(300),
  rationale: z.string().trim().min(1).max(400),
  sourceSlideIds: z.array(z.string().max(40)).max(10),
  /** New exercise or content not in the source. */
  addedPractice: z.boolean(),
  /** Changes outcomes, difficulty of questions or answer rules — only allowed in a learning-challenge plan. */
  changesLearning: z.boolean(),
});
export type AdaptationItem = z.infer<typeof adaptationItemSchema>;

export const gradeAdaptationPlanSchema = z.object({
  summary: z.string().trim().min(1).max(800),
  items: z.array(adaptationItemSchema).max(40),
  motionPurpose: z.string().trim().min(1).max(500),
  assumptions: z.array(z.string().trim().min(1).max(240)).max(10),
  curriculumNote: z.string().max(300),
});
export type GradeAdaptationPlan = z.infer<typeof gradeAdaptationPlanSchema>;

export const gradePlanDecision = z.enum(['pending', 'accepted', 'rejected']);

export const gradePlanRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branchId: z.string(),
  number: z.number().int(),
  gradeProfileId: z.string(),
  gradeProfileRevision: z.number().int(),
  fromGrade: z.string().nullable(),
  toGrade: z.string(),
  /** presentation: copy/guidance only; challenge: learning changes that need instructional review and blueprint approval. */
  mode: z.enum(['presentation', 'challenge']),
  origin: z.enum(['claude', 'preset', 'demo']),
  model: z.string().nullable(),
  /** Game version the plan was made against (null when staged before the first build). */
  baseVersionId: z.string().nullable(),
  baseVersionNumber: z.number().int().nullable(),
  basis: z.object({ blueprintRevisionId: z.string().nullable(), blueprintRevisionNumber: z.number().int().nullable(), screenMapNumber: z.number().int().nullable() }),
  status: z.enum(['proposed', 'applied', 'rejected', 'stale', 'superseded']),
  plan: gradeAdaptationPlanSchema,
  /** Per-item review decision, keyed by item id. */
  decisions: z.record(z.string(), gradePlanDecision),
  proposalId: z.string().nullable(),
  /** Draft blueprint created for the learning changes of a challenge plan. */
  blueprintRevisionId: z.string().nullable(),
  resultVersionId: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type GradePlanRecord = z.infer<typeof gradePlanRecordSchema>;
