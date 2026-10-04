import { z } from 'zod';
import { shortText } from './common.ts';

/**
 * Motion is data, never code: an AnimationBinding names a screen, a target
 * entity, a trigger from a fixed list of runtime events, and a preset from the
 * registry in `shared/src/motion/presets.ts` with allowlisted parameters. The
 * trusted runtime interprets it; nothing here can carry JavaScript, selectors,
 * URLs or formulas.
 */

/** Runtime events a binding can react to. Every one is emitted by the runtime itself. */
export const MOTION_TRIGGERS = [
  'scene-entered',
  'control-activated',
  'instruction-advanced',
  'object-selected',
  'valid-drop',
  'correct-answer',
  'retry-requested',
  'scene-completed',
] as const;
export const motionTrigger = z.enum(MOTION_TRIGGERS);
export type MotionTrigger = z.infer<typeof motionTrigger>;

export const TRIGGER_LABELS: Record<MotionTrigger, string> = {
  'scene-entered': 'the screen opens',
  'control-activated': 'a button is pressed',
  'instruction-advanced': 'the learner reveals the next hint or step',
  'object-selected': 'the learner selects an object',
  'valid-drop': 'an object is placed in a valid spot',
  'correct-answer': 'the answer is correct',
  'retry-requested': 'an answer is checked and is not right yet',
  'scene-completed': 'the screen is completed',
};

export const MOTION_CONTROLS = ['start', 'check', 'hint', 'reset', 'next', 'continue', 'replay'] as const;
export const motionControl = z.enum(MOTION_CONTROLS);
export type MotionControl = z.infer<typeof motionControl>;

export const MOTION_PRESET_IDS = [
  'fade-in',
  'slide-in',
  'pop-in',
  'outline-highlight',
  'label-reveal',
  'path-reveal',
  'attention-cue',
  'move-to',
  'move-by',
  'follow-path',
  'press',
  'selected-outline',
  'drop-snap',
  'success-highlight',
  'celebration-clip',
  'particle-burst',
  'retry-cue',
  'guided-return',
  'scene-cut',
  'scene-fade',
  'scene-slide',
  'character-clip',
] as const;
export const motionPresetId = z.enum(MOTION_PRESET_IDS);
export type MotionPresetId = z.infer<typeof motionPresetId>;

export const motionPurpose = z.enum(['instructional', 'feedback', 'decorative']);
export type MotionPurpose = z.infer<typeof motionPurpose>;

/** What happens when reduced motion is on: settle to the end state, show discrete steps, skip, or keep (non-motion effects). */
export const reducedMotionMode = z.enum(['static', 'stepwise', 'skip', 'unchanged']);
export type ReducedMotionMode = z.infer<typeof reducedMotionMode>;

export const motionEasing = z.enum(['linear', 'ease-out', 'ease-in-out', 'ease-in']);
export type MotionEasing = z.infer<typeof motionEasing>;

export const motionOrigin = z.enum(['creator', 'claude', 'preset', 'demo', 'design-evidence', 'source']);
export type MotionOrigin = z.infer<typeof motionOrigin>;

export const screenIdSchema = z.string().regex(/^(title|completion|[A-Za-z0-9_-]{1,40})$/, 'Unknown screen');
export const entityIdSchema = z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/, 'Unknown object');

export const motionParamValue = z.union([z.number().finite(), z.string().max(200), z.boolean()]);

export const animationBindingSchema = z.object({
  id: z.string().regex(/^anim-[a-z0-9-]{1,30}$/),
  screenId: screenIdSchema,
  target: entityIdSchema,
  presetId: motionPresetId,
  trigger: z.object({
    event: motionTrigger,
    /** Only for control-activated: which control. */
    control: motionControl.nullable(),
    /** Only for valid-drop / object-selected: limit to one target or object (entity id), or any. */
    entity: entityIdSchema.nullable(),
  }),
  params: z.record(z.string().regex(/^[a-zA-Z]{1,24}$/), motionParamValue),
  timing: z.object({
    delayMs: z.number().int().min(0).max(10_000),
    durationMs: z.number().int().min(80).max(6_000),
    easing: motionEasing,
    repeat: z.number().int().min(1).max(3),
  }),
  /** Sequencing: start when this binding (same screen) finishes; null = start with the trigger. */
  after: z.string().regex(/^anim-[a-z0-9-]{1,30}$/).nullable(),
  reducedMotion: reducedMotionMode,
  purpose: motionPurpose,
  origin: motionOrigin,
  /** Sprite asset for a clip played on top of the target (e.g. an uploaded celebration sprite). */
  assetId: z.string().max(64).nullable(),
  sound: z.object({ assetId: z.string().max(64), volume: z.number().min(0).max(1) }).nullable(),
  /** Readable rule, e.g. “When Screen 2 opens → play Swiftee's wave clip once.” */
  label: shortText(160),
  /** Grade profile revision that was current when this binding was suggested or created. */
  gradeProfileRevision: z.number().int().min(0).nullable(),
  enabled: z.boolean(),
});
export type AnimationBinding = z.infer<typeof animationBindingSchema>;

export const motionProfile = z.enum(['minimal', 'guided', 'playful']);
export type MotionProfile = z.infer<typeof motionProfile>;

export const motionSettingsSchema = z.object({
  profile: motionProfile,
  pacing: z.enum(['calm', 'standard']),
  decorativeIntensity: z.enum(['off', 'low', 'standard']),
  sound: z.boolean(),
  soundVolume: z.number().min(0).max(1),
  /** follow-device: honour the learner's system setting; always: reduced motion for everyone. */
  reducedMotion: z.enum(['follow-device', 'always']),
  /** Low-effects mode: no particles, fewer simultaneous animations. */
  lowEffects: z.boolean(),
});
export type MotionSettings = z.infer<typeof motionSettingsSchema>;

export const PROFILE_DEFAULTS: Record<MotionProfile, Omit<MotionSettings, 'profile' | 'sound' | 'soundVolume' | 'reducedMotion' | 'lowEffects'>> = {
  minimal: { pacing: 'standard', decorativeIntensity: 'off' },
  guided: { pacing: 'calm', decorativeIntensity: 'low' },
  playful: { pacing: 'standard', decorativeIntensity: 'standard' },
};

export const DEFAULT_MOTION_SETTINGS: MotionSettings = {
  profile: 'guided',
  pacing: 'calm',
  decorativeIntensity: 'low',
  sound: true,
  soundVolume: 0.7,
  reducedMotion: 'follow-device',
  lowEffects: false,
};

export const motionConfigSchema = motionSettingsSchema.extend({
  bindings: z.array(animationBindingSchema).max(120),
  /** Screens whose approved motion must not change (set by the creator only). */
  lockedScreens: z.array(screenIdSchema).max(30).default([]),
});
export type MotionConfig = z.infer<typeof motionConfigSchema>;

export const DEFAULT_MOTION_CONFIG: MotionConfig = { ...DEFAULT_MOTION_SETTINGS, bindings: [], lockedScreens: [] };

export const MOTION_SETTING_FIELDS = ['profile', 'pacing', 'decorativeIntensity', 'sound', 'soundVolume', 'reducedMotion', 'lowEffects'] as const;
export const motionSettingField = z.enum(MOTION_SETTING_FIELDS);
export type MotionSettingField = z.infer<typeof motionSettingField>;

export const MOTION_SETTING_LABELS: Record<MotionSettingField, string> = {
  profile: 'Motion profile',
  pacing: 'Pacing',
  decorativeIntensity: 'Decorative effects',
  sound: 'Animation sounds',
  soundVolume: 'Sound volume',
  reducedMotion: 'Reduced motion',
  lowEffects: 'Low-effects mode',
};

// ───────────── MotionPlan: proposed motion, reviewed row by row ─────────────

export const planDecision = z.enum(['pending', 'accepted', 'rejected']);
export type PlanDecision = z.infer<typeof planDecision>;

/** A request the registry cannot honour, reported instead of faked. */
export const unsupportedMotionSchema = z.object({
  request: z.string().trim().min(1).max(300),
  reason: z.string().trim().min(1).max(400),
  alternative: z.string().max(300).nullable(),
  /** Needs a developer (custom code or new assets) rather than a preset. */
  handoff: z.boolean(),
});
export type UnsupportedMotion = z.infer<typeof unsupportedMotionSchema>;

/** How a phrase in the request was resolved to a screen / object chip. */
export const resolvedReferenceSchema = z.object({
  phrase: z.string().max(120),
  screenId: screenIdSchema.nullable(),
  entityId: entityIdSchema.nullable(),
  assetId: z.string().max(64).nullable(),
  label: z.string().max(160),
});
export type ResolvedReference = z.infer<typeof resolvedReferenceSchema>;

export const motionPlanSchema = z.object({
  summary: z.string().trim().min(1).max(800),
  /** Settings changes, if any (only the fields listed are changed). */
  settings: motionSettingsSchema.partial().nullable(),
  add: z.array(animationBindingSchema).max(40),
  /** Existing bindings to remove (by id), each with a reason. */
  remove: z.array(z.object({ id: z.string().regex(/^anim-[a-z0-9-]{1,30}$/), reason: z.string().max(300) })).max(40),
  unsupported: z.array(unsupportedMotionSchema).max(10),
  resolved: z.array(resolvedReferenceSchema).max(20),
  notes: z.array(z.string().max(300)).max(8),
});
export type MotionPlan = z.infer<typeof motionPlanSchema>;

export const motionPlanScopeSchema = z.object({
  kind: z.enum(['project', 'screen']),
  screenId: screenIdSchema.nullable(),
});
export type MotionPlanScope = z.infer<typeof motionPlanScopeSchema>;

export const motionPlanRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branchId: z.string(),
  number: z.number().int(),
  gradeProfileRevision: z.number().int().nullable(),
  origin: z.enum(['preset', 'claude', 'demo', 'creator']),
  model: z.string().nullable(),
  request: z.string(),
  scope: motionPlanScopeSchema,
  /** The game version the plan was made against (null for a plan staged before the first build). */
  baseVersionId: z.string().nullable(),
  baseVersionNumber: z.number().int().nullable(),
  basis: z.object({ blueprintRevisionId: z.string().nullable(), screenMapNumber: z.number().int().nullable() }),
  status: z.enum(['proposed', 'applied', 'rejected', 'stale', 'superseded']),
  plan: motionPlanSchema,
  /** Row decisions: binding id for additions, `remove:<id>` for removals, `settings` for the settings change. */
  decisions: z.record(z.string(), planDecision),
  proposalId: z.string().nullable(),
  resultVersionId: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type MotionPlanRecord = z.infer<typeof motionPlanRecordSchema>;

/** Hard budgets enforced by validation and again by the runtime scheduler. */
export const MOTION_BUDGET = {
  bindingsPerScreen: 24,
  bindingsPerTrigger: 8,
  particlePresetsPerScreen: 2,
  maxChainDepth: 6,
  concurrentAnimations: 12,
  particlesPerBurst: 40,
  concurrentBursts: 2,
} as const;
