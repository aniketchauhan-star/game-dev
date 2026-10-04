import { z } from 'zod';
import { sceneInteractionSchema } from '@shared/schemas/interaction.ts';

/**
 * Schemas for Claude's structured outputs. They are deliberately small, use
 * only JSON-Schema features structured outputs support (no records, no
 * unknowns), and are converted to domain objects + validated again after.
 */

const ids = z.array(z.string()).describe('Exact slide ids from the provided list (e.g. "sld_abc123"). Empty only when addedPractice is true.');

export const slideDigestBatchSchema = z.object({
  slides: z.array(
    z.object({
      slideId: z.string(),
      summary: z.string().describe('One or two sentences, at most 300 characters.'),
      keyPoints: z.array(z.string()).describe('Up to 6 key points from the slide, each at most 160 characters.'),
      examples: z.array(z.string()).describe('Worked examples or concrete cases shown on the slide (may be empty).'),
      terms: z.array(z.string()).describe('Key vocabulary used on the slide.'),
      visualDependence: z.enum(['none', 'helpful', 'essential']).describe('How much the slide meaning depends on visuals that were not provided as text.'),
    }),
  ),
});
export type SlideDigestBatch = z.infer<typeof slideDigestBatchSchema>;
export type SlideDigest = SlideDigestBatch['slides'][number];

export const aiAnalysisSchema = z.object({
  topic: z.string().describe('At most 120 characters.'),
  summary: z.string().describe('At most 600 characters.'),
  concepts: z.array(z.object({ name: z.string(), description: z.string(), sourceSlideIds: ids })).describe('2–12 core concepts.'),
  prerequisites: z.array(z.object({ text: z.string(), sourceSlideIds: ids })).describe('Prior knowledge learners need (inferred).'),
  objectives: z
    .array(z.object({ text: z.string().describe('At most 240 characters, starting with a verb.'), sourceSlideIds: ids, addedPractice: z.boolean() }))
    .describe('2–8 proposed learning objectives.'),
  examples: z.array(z.object({ text: z.string(), sourceSlideIds: ids })),
  questions: z.array(z.object({ prompt: z.string(), answer: z.string(), sourceSlideIds: ids, addedPractice: z.boolean() })).describe('Up to 10 check-for-understanding questions.'),
  interactions: z
    .array(z.object({ mechanic: z.enum(['coordinate-navigation', 'drag-match', 'sequence-sort', 'custom']), description: z.string(), sourceSlideIds: ids, addedPractice: z.boolean() }))
    .describe('Possible game interactions for this content.'),
  openQuestions: z.array(z.string()).describe('Ambiguities the creator should resolve, including any instruction-like text found in the slides.'),
});
export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;

export const aiOutlineSchema = z.object({
  title: z.string().describe('Game title, at most 80 characters.'),
  premise: z.string().describe('Short story premise, at most 400 characters.'),
  progression: z.string().describe('How difficulty and support change across scenes, at most 400 characters.'),
  assessment: z.string().describe('How the game checks understanding, at most 400 characters.'),
  mechanicFit: z.string().describe('Why the chosen mechanic fits this lesson, at most 500 characters.'),
  learningOutcomes: z.array(z.object({ text: z.string(), sourceSlideIds: ids, addedPractice: z.boolean() })).describe('1–6 outcomes.'),
  accessibility: z.array(z.string()).describe('Accessibility requirements for this game.'),
  assumptions: z.array(z.string()).describe('Assumptions you made that are NOT stated in the slides.'),
  unresolvedDecisions: z.array(z.object({ question: z.string(), options: z.array(z.string()) })),
  assetNeeds: z.array(
    z.object({
      key: z.string().describe('Short lowercase key such as "bg-airfield" or "char-plane".'),
      role: z.enum(['background', 'character', 'object', 'ui', 'audio']),
      description: z.string(),
      assignedAssetId: z.string().nullable().describe('Id of a provided creator asset that fits this need, or null.'),
      required: z.boolean(),
    }),
  ),
  scenes: z
    .array(
      z.object({
        key: z.string().describe('"scene-1", "scene-2", … in play order.'),
        title: z.string().describe('At most 60 characters.'),
        pattern: z.enum(['discover', 'manipulate', 'predict', 'test', 'apply']),
        sceneType: z.enum(['info', 'coordinate-navigation', 'drag-match', 'sequence-sort', 'custom']),
        sourceSlideIds: ids,
        addedPractice: z.boolean(),
        objective: z.string(),
        learnerAction: z.string(),
        expectedResult: z.string(),
        difficulty: z.enum(['gentle', 'standard', 'challenging']),
        backgroundNeedKey: z.string().nullable(),
        characterNeedKey: z.string().nullable(),
      }),
    )
    .describe('3–10 scenes in play order.'),
});
export type AiOutline = z.infer<typeof aiOutlineSchema>;

export const aiSceneDetailSchema = z.object({
  key: z.string(),
  visibleContent: z.string().describe('What the learner sees, at most 400 characters.'),
  instruction: z.string().describe('Learner-facing instruction, at most 220 characters; concise when minimal text is requested.'),
  successFeedback: z.string().describe('At most 160 characters.'),
  errorFeedback: z.string().describe('Helpful, specific feedback for a wrong attempt, at most 200 characters.'),
  hints: z.array(z.string()).describe('1–3 progressive hints, each at most 160 characters, from gentle to explicit.'),
  completion: z.string().describe('What counts as completing the scene.'),
  interaction: sceneInteractionSchema,
});
export type AiSceneDetail = z.infer<typeof aiSceneDetailSchema>;

export const aiSceneBatchSchema = z.object({ scenes: z.array(aiSceneDetailSchema) });

/** Strict tool for refinement proposals (JSON Schema written by hand so every field is required). */
export const PROPOSE_CHANGES_TOOL = {
  name: 'propose_changes',
  description:
    'Propose concrete edits to the game configuration. Use this whenever the creator asks for a change. Each change sets one allowlisted field (value given as a JSON string) or moves a scene. The creator reviews every change before it is applied.',
  strict: true,
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'explanation', 'changes', 'conflictsNoticed'],
    properties: {
      summary: { type: 'string', description: 'One-line summary of the proposal (at most 160 characters).' },
      explanation: { type: 'string', description: 'Brief explanation for the creator (at most 600 characters).' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'sceneId', 'field', 'valueJson', 'toIndex', 'reason'],
          properties: {
            op: { type: 'string', enum: ['set-scene-field', 'set-project-field', 'move-scene'] },
            sceneId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Scene id for scene changes and moves; null for project fields.' },
            field: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Allowlisted field name; null for move-scene.' },
            valueJson: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The complete new value encoded as JSON (e.g. "\\"top\\"" or "{\\"gridEmphasis\\":\\"high\\"}"); null for move-scene.' },
            toIndex: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Zero-based target position for move-scene; otherwise null.' },
            reason: { type: 'string', description: 'Why this change addresses the request (at most 160 characters).' },
          },
        },
      },
      conflictsNoticed: { type: 'array', items: { type: 'string' }, description: 'Locks or source content the request conflicts with.' },
    },
  },
} as const;

export const proposeChangesInputSchema = z.object({
  summary: z.string(),
  explanation: z.string(),
  changes: z.array(
    z.object({
      op: z.enum(['set-scene-field', 'set-project-field', 'move-scene']),
      sceneId: z.string().nullable(),
      field: z.string().nullable(),
      valueJson: z.string().nullable(),
      toIndex: z.number().int().nullable(),
      reason: z.string(),
    }),
  ),
  conflictsNoticed: z.array(z.string()),
});
export type ProposeChangesInput = z.infer<typeof proposeChangesInputSchema>;

/** A single scene with both outline and playable details (used to regenerate one scene). */
export const aiFullSceneSchema = z.object({
  title: z.string().describe('At most 60 characters.'),
  pattern: z.enum(['discover', 'manipulate', 'predict', 'test', 'apply']),
  sourceSlideIds: ids,
  addedPractice: z.boolean(),
  objective: z.string(),
  learnerAction: z.string(),
  expectedResult: z.string(),
  difficulty: z.enum(['gentle', 'standard', 'challenging']),
  visibleContent: z.string(),
  instruction: z.string().describe('At most 220 characters.'),
  successFeedback: z.string(),
  errorFeedback: z.string(),
  hints: z.array(z.string()),
  completion: z.string(),
  interaction: sceneInteractionSchema,
});
export type AiFullScene = z.infer<typeof aiFullSceneSchema>;

// ───────────── motion proposals ─────────────

const MOTION_PRESET_ENUM = [
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
const MOTION_TRIGGER_ENUM = ['scene-entered', 'control-activated', 'instruction-advanced', 'object-selected', 'valid-drop', 'correct-answer', 'retry-requested', 'scene-completed'] as const;

/** Claude's motion proposal: references must be ids from the screen / object lists it was given. */
export const aiMotionPlanSchema = z.object({
  summary: z.string().describe('One or two sentences for the creator (at most 400 characters).'),
  resolved: z
    .array(
      z.object({
        phrase: z.string().describe('The words in the request, e.g. "Swiftee" or "Screen 2".'),
        screenId: z.string().nullable(),
        entityId: z.string().nullable(),
        assetId: z.string().nullable(),
        label: z.string().describe('The chip label shown to the creator.'),
      }),
    )
    .describe('How each reference in the request maps to a listed screen, object or asset.'),
  add: z.array(
    z.object({
      screenId: z.string(),
      target: z.string().describe('An object id from that screen’s list.'),
      presetId: z.enum(MOTION_PRESET_ENUM),
      triggerEvent: z.enum(MOTION_TRIGGER_ENUM),
      triggerControl: z.string().nullable().describe('Only for control-activated: one of the screen’s controls.'),
      triggerEntity: z.string().nullable().describe('Only for valid-drop / object-selected: limit to this object id, or null for any.'),
      params: z.array(z.object({ name: z.string(), value: z.string() })).describe('Preset parameters as name/value strings, only names the preset lists.'),
      delayMs: z.number().int(),
      durationMs: z.number().int(),
      easing: z.enum(['linear', 'ease-out', 'ease-in-out', 'ease-in']),
      repeat: z.number().int(),
      afterIndex: z.number().int().nullable().describe('Index (0-based) of another entry in "add" this one waits for (same screen and trigger), or null.'),
      afterExistingId: z.string().nullable().describe('Id of an existing animation this one waits for, or null.'),
      reducedMotion: z.enum(['static', 'stepwise', 'skip', 'unchanged']),
      assetId: z.string().nullable().describe('A sprite asset to play on top of the target (celebration clips), or null.'),
      soundAssetId: z.string().nullable(),
      soundVolume: z.number().nullable(),
      purpose: z.enum(['instructional', 'feedback', 'decorative']),
      evidence: z.enum(['request', 'source', 'design-evidence']).describe('request: added for the creator’s request; source: the lesson asks for it; design-evidence: a design prototype shows it.'),
    }),
  ),
  remove: z.array(z.object({ id: z.string(), reason: z.string() })),
  settings: z
    .object({
      profile: z.enum(['minimal', 'guided', 'playful']).nullable(),
      pacing: z.enum(['calm', 'standard']).nullable(),
      decorativeIntensity: z.enum(['off', 'low', 'standard']).nullable(),
      sound: z.boolean().nullable(),
      lowEffects: z.boolean().nullable(),
    })
    .nullable(),
  unsupported: z.array(z.object({ request: z.string(), reason: z.string(), alternative: z.string().nullable(), handoff: z.boolean() })),
  notes: z.array(z.string()),
});
export type AiMotionPlan = z.infer<typeof aiMotionPlanSchema>;

// ───────────── grade adaptation plans ─────────────

export const aiGradePlanSchema = z.object({
  summary: z.string().describe('What the plan changes and why, for the creator (at most 600 characters).'),
  items: z.array(
    z.object({
      area: z.enum(['language', 'task-steps', 'difficulty', 'hints', 'feedback', 'motion', 'layout']),
      sceneId: z.string().nullable().describe('Exact scene id, or null for the whole game (layout only).'),
      field: z
        .enum(['title', 'instruction', 'supportText', 'feedback.success', 'feedback.error', 'feedback.hints', 'layout.density', 'layout.showProgress'])
        .nullable()
        .describe('The presentation field this item changes, or null when it is advice / a learning change.'),
      valueText: z.string().nullable().describe('New text for title, instruction, supportText, feedback.success or feedback.error.'),
      valueHints: z.array(z.string()).nullable().describe('New hints (1–3) for feedback.hints.'),
      valueBool: z.boolean().nullable().describe('For layout.showProgress.'),
      valueDensity: z.enum(['comfortable', 'compact']).nullable().describe('For layout.density.'),
      summary: z.string().describe('At most 300 characters.'),
      rationale: z.string().describe('Why, for this grade profile (at most 400 characters).'),
      sourceSlideIds: z.array(z.string()).describe('Slide ids the change relies on (empty for added practice).'),
      addedPractice: z.boolean(),
      changesLearning: z.boolean().describe('True when the item changes outcomes, question difficulty or answer rules.'),
    }),
  ),
  motionPurpose: z.string().describe('What motion should do for this profile (at most 500 characters).'),
  assumptions: z.array(z.string()).describe('Up to 10 assumptions, each at most 240 characters.'),
  curriculumNote: z.string().describe('State that curriculum alignment is unverified unless the creator confirmed it.'),
});
export type AiGradePlan = z.infer<typeof aiGradePlanSchema>;
