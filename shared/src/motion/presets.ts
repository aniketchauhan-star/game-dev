import { z } from 'zod';
import type { MotionPresetId, MotionPurpose, MotionTrigger, ReducedMotionMode } from '../schemas/motion.ts';

/**
 * The motion preset registry — a small, real list. Each preset says what it is
 * for, what it can target, which parameters it accepts (allowlisted and
 * bounded), and what happens with reduced motion. There are deliberately no
 * strobe, screen-shake or rapid flashing presets, and retry feedback is never
 * punitive.
 */

export type EntityKind =
  | 'screen'
  | 'panel'
  | 'text'
  | 'image'
  | 'sprite'
  | 'card'
  | 'target'
  | 'control'
  | 'grid'
  | 'mover'
  | 'shape'
  | 'list'
  | 'tray';

export type PresetCategory = 'entrance' | 'emphasis' | 'movement' | 'feedback' | 'success' | 'retry' | 'transition' | 'character';

export const CATEGORY_LABELS: Record<PresetCategory, string> = {
  entrance: 'Entrance',
  emphasis: 'Instructional emphasis',
  movement: 'Object movement',
  feedback: 'Interaction feedback',
  success: 'Success',
  retry: 'Retry',
  transition: 'Scene transition',
  character: 'Character animation',
};

export interface MotionPreset {
  id: MotionPresetId;
  label: string;
  category: PresetCategory;
  purpose: MotionPurpose;
  /** What the preset does, in plain words. */
  summary: string;
  /** What learners see with reduced motion. */
  staticAlternative: string;
  defaultReduced: ReducedMotionMode;
  targets: EntityKind[];
  /** Triggers that make sense; null = any trigger. */
  triggers: MotionTrigger[] | null;
  /** Needs a sprite with clips (the target, or an asset played on top of it). */
  requiresClip: boolean;
  duration: { min: number; max: number; default: number };
  maxRepeat: number;
  /** Which visual property the preset drives (used for conflict rules). */
  channel: 'transform' | 'opacity' | 'outline' | 'sprite' | 'overlay' | 'reveal' | 'none';
  params: z.ZodType<Record<string, string | number | boolean>>;
  defaults: Record<string, string | number | boolean>;
}

const VISUAL: EntityKind[] = ['panel', 'text', 'image', 'sprite', 'card', 'target', 'control', 'shape', 'list', 'mover', 'grid', 'tray'];
const MOVABLE: EntityKind[] = ['image', 'sprite', 'shape', 'text', 'card', 'panel'];
const color = z.enum(['accent', 'primary', 'success', 'focus']);
const entityRef = z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/);
const clipName = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
/** Up to 8 relative waypoints "dx,dy dx,dy …" in stage pixels. */
const pathString = z.string().regex(/^-?\d{1,4}(\.\d+)?,-?\d{1,4}(\.\d+)?( -?\d{1,4}(\.\d+)?,-?\d{1,4}(\.\d+)?){0,7}$/);

const PRESETS: MotionPreset[] = [
  {
    id: 'fade-in',
    label: 'Fade in',
    category: 'entrance',
    purpose: 'decorative',
    summary: 'The object fades into view.',
    staticAlternative: 'The object is simply shown.',
    defaultReduced: 'static',
    targets: VISUAL,
    triggers: null,
    requiresClip: false,
    duration: { min: 120, max: 1600, default: 400 },
    maxRepeat: 1,
    channel: 'opacity',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'slide-in',
    label: 'Slide in from an edge',
    category: 'entrance',
    purpose: 'decorative',
    summary: 'The object slides a short distance into its approved place while fading in.',
    staticAlternative: 'The object is shown in place.',
    defaultReduced: 'static',
    targets: VISUAL,
    triggers: null,
    requiresClip: false,
    duration: { min: 160, max: 1600, default: 480 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({ from: z.enum(['left', 'right', 'top', 'bottom']), distance: z.number().int().min(20).max(600) }).strict(),
    defaults: { from: 'left', distance: 160 },
  },
  {
    id: 'pop-in',
    label: 'Pop in (restrained)',
    category: 'entrance',
    purpose: 'decorative',
    summary: 'The object grows slightly into view — a single, small scale change.',
    staticAlternative: 'The object is shown at full size.',
    defaultReduced: 'static',
    targets: VISUAL,
    triggers: null,
    requiresClip: false,
    duration: { min: 120, max: 900, default: 320 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({ from: z.number().min(0.6).max(0.95) }).strict(),
    defaults: { from: 0.85 },
  },
  {
    id: 'outline-highlight',
    label: 'Outline highlight',
    category: 'emphasis',
    purpose: 'instructional',
    summary: 'A soft outline draws attention to the object, pulsing gently once or twice.',
    staticAlternative: 'A steady outline is shown for the same time.',
    defaultReduced: 'stepwise',
    targets: VISUAL,
    triggers: null,
    requiresClip: false,
    duration: { min: 300, max: 4000, default: 1400 },
    maxRepeat: 2,
    channel: 'outline',
    params: z.object({ color, width: z.number().int().min(3).max(12), pulses: z.number().int().min(1).max(3) }).strict(),
    defaults: { color: 'accent', width: 6, pulses: 2 },
  },
  {
    id: 'label-reveal',
    label: 'Step-by-step reveal',
    category: 'emphasis',
    purpose: 'instructional',
    summary: 'The points of a list or label appear one at a time.',
    staticAlternative: 'All points are shown at once.',
    defaultReduced: 'static',
    targets: ['list', 'text', 'panel'],
    triggers: null,
    requiresClip: false,
    duration: { min: 300, max: 6000, default: 1800 },
    maxRepeat: 1,
    channel: 'reveal',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'path-reveal',
    label: 'Pointer / path reveal',
    category: 'emphasis',
    purpose: 'instructional',
    summary: 'An arrow is drawn from this object to another, showing a relationship.',
    staticAlternative: 'The arrow is shown complete, without drawing.',
    defaultReduced: 'static',
    targets: VISUAL,
    triggers: null,
    requiresClip: false,
    duration: { min: 300, max: 4000, default: 1200 },
    maxRepeat: 1,
    channel: 'overlay',
    params: z.object({ to: entityRef, style: z.enum(['arrow', 'dotted']), hold: z.number().int().min(0).max(8000) }).strict(),
    defaults: { to: 'instruction', style: 'arrow', hold: 1500 },
  },
  {
    id: 'attention-cue',
    label: 'Gentle attention cue',
    category: 'emphasis',
    purpose: 'instructional',
    summary: 'A single, gentle nudge in size to say “look here”. Never repeated rapidly.',
    staticAlternative: 'A steady outline is shown briefly.',
    defaultReduced: 'stepwise',
    targets: VISUAL,
    triggers: null,
    requiresClip: false,
    duration: { min: 300, max: 1500, default: 700 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'move-to',
    label: 'Move to a position',
    category: 'movement',
    purpose: 'instructional',
    summary: 'The object moves to another approved position (a point on the stage or another object). Game positions and answers are not changed.',
    staticAlternative: 'The object appears at the end position.',
    defaultReduced: 'static',
    targets: MOVABLE,
    triggers: null,
    requiresClip: false,
    duration: { min: 200, max: 4000, default: 900 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({ to: entityRef.optional(), x: z.number().min(-200).max(2120).optional(), y: z.number().min(-200).max(1280).optional() }).strict(),
    defaults: { x: 960, y: 540 },
  },
  {
    id: 'move-by',
    label: 'Move by an amount',
    category: 'movement',
    purpose: 'instructional',
    summary: 'The object moves by a set amount — in stage pixels, or in grid units on a coordinate screen. Game positions and answers are not changed.',
    staticAlternative: 'The object appears at the end position.',
    defaultReduced: 'static',
    targets: [...MOVABLE, 'mover'],
    triggers: null,
    requiresClip: false,
    duration: { min: 200, max: 4000, default: 900 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({ dx: z.number().min(-1920).max(1920), dy: z.number().min(-1080).max(1080), units: z.enum(['stage', 'grid']) }).strict(),
    defaults: { dx: 120, dy: 0, units: 'stage' },
  },
  {
    id: 'follow-path',
    label: 'Follow an approved path',
    category: 'movement',
    purpose: 'instructional',
    summary: 'The object follows up to eight waypoints relative to where it starts.',
    staticAlternative: 'The object appears at the final waypoint.',
    defaultReduced: 'static',
    targets: MOVABLE,
    triggers: null,
    requiresClip: false,
    duration: { min: 300, max: 6000, default: 1600 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({ path: pathString }).strict(),
    defaults: { path: '120,0 120,-80' },
  },
  {
    id: 'press',
    label: 'Button press',
    category: 'feedback',
    purpose: 'feedback',
    summary: 'A short press-down on the button that was used.',
    staticAlternative: 'No motion (the button still responds).',
    defaultReduced: 'skip',
    targets: ['control'],
    triggers: ['control-activated'],
    requiresClip: false,
    duration: { min: 80, max: 400, default: 160 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'selected-outline',
    label: 'Selected-state outline',
    category: 'feedback',
    purpose: 'feedback',
    summary: 'A clear outline confirms which object is selected.',
    staticAlternative: 'The outline appears without animation.',
    defaultReduced: 'stepwise',
    targets: ['card', 'image', 'sprite', 'shape'],
    triggers: ['object-selected'],
    requiresClip: false,
    duration: { min: 150, max: 2000, default: 600 },
    maxRepeat: 1,
    channel: 'outline',
    params: z.object({ color }).strict(),
    defaults: { color: 'focus' },
  },
  {
    id: 'drop-snap',
    label: 'Valid-drop snap',
    category: 'feedback',
    purpose: 'feedback',
    summary: 'When an object lands in a valid spot it settles into place with a small snap.',
    staticAlternative: 'The object is placed without motion.',
    defaultReduced: 'skip',
    targets: ['card', 'target'],
    triggers: ['valid-drop'],
    requiresClip: false,
    duration: { min: 120, max: 700, default: 260 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'success-highlight',
    label: 'Brief success highlight',
    category: 'success',
    purpose: 'feedback',
    summary: 'A brief glow in the success colour.',
    staticAlternative: 'A steady success outline for the same time.',
    defaultReduced: 'stepwise',
    targets: VISUAL,
    triggers: null,
    requiresClip: false,
    duration: { min: 200, max: 2000, default: 800 },
    maxRepeat: 1,
    channel: 'outline',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'celebration-clip',
    label: 'Celebration clip',
    category: 'success',
    purpose: 'decorative',
    summary: 'Plays a named clip once — from the target sprite or an uploaded celebration sprite shown on top. Learners can skip it.',
    staticAlternative: 'The clip’s final frame is shown briefly.',
    defaultReduced: 'static',
    targets: ['sprite', 'image', 'card', 'target', 'panel', 'screen'],
    triggers: null,
    requiresClip: true,
    duration: { min: 300, max: 4000, default: 1200 },
    maxRepeat: 1,
    channel: 'sprite',
    params: z.object({ clip: clipName }).strict(),
    defaults: { clip: 'celebrate' },
  },
  {
    id: 'particle-burst',
    label: 'Small particle burst',
    category: 'success',
    purpose: 'decorative',
    summary: 'A small, bounded burst of particles around the object (never full-screen). Off in low-effects mode.',
    staticAlternative: 'Nothing extra is shown.',
    defaultReduced: 'skip',
    targets: VISUAL,
    triggers: null,
    requiresClip: false,
    duration: { min: 400, max: 1600, default: 1000 },
    maxRepeat: 1,
    channel: 'overlay',
    params: z.object({ count: z.number().int().min(6).max(40), spread: z.number().int().min(40).max(360), colors: z.enum(['palette', 'success', 'accent']) }).strict(),
    defaults: { count: 16, spread: 160, colors: 'palette' },
  },
  {
    id: 'retry-cue',
    label: 'Retry outline cue',
    category: 'retry',
    purpose: 'feedback',
    summary: 'A calm outline shows where to look again — no shaking, no alarm colours.',
    staticAlternative: 'A steady outline is shown briefly.',
    defaultReduced: 'stepwise',
    targets: VISUAL,
    triggers: ['retry-requested', 'control-activated'],
    requiresClip: false,
    duration: { min: 300, max: 3000, default: 1200 },
    maxRepeat: 1,
    channel: 'outline',
    params: z.object({ color: z.enum(['focus', 'accent', 'primary']) }).strict(),
    defaults: { color: 'focus' },
  },
  {
    id: 'guided-return',
    label: 'Guided return',
    category: 'retry',
    purpose: 'instructional',
    summary: 'When the learner presses Reset, the pieces the game puts back glide to their starting places so the change is easy to follow. The game itself does the reset; the motion only shows it.',
    staticAlternative: 'Objects are shown back in their starting places.',
    defaultReduced: 'static',
    targets: ['card', 'mover'],
    triggers: ['control-activated'],
    requiresClip: false,
    duration: { min: 200, max: 1600, default: 600 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'scene-cut',
    label: 'Cut',
    category: 'transition',
    purpose: 'decorative',
    summary: 'The screen appears immediately.',
    staticAlternative: 'The same.',
    defaultReduced: 'unchanged',
    targets: ['screen'],
    triggers: ['scene-entered'],
    requiresClip: false,
    duration: { min: 80, max: 200, default: 80 },
    maxRepeat: 1,
    channel: 'none',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'scene-fade',
    label: 'Fade',
    category: 'transition',
    purpose: 'decorative',
    summary: 'The screen fades in.',
    staticAlternative: 'The screen appears immediately.',
    defaultReduced: 'static',
    targets: ['screen'],
    triggers: ['scene-entered'],
    requiresClip: false,
    duration: { min: 120, max: 1200, default: 360 },
    maxRepeat: 1,
    channel: 'opacity',
    params: z.object({}).strict(),
    defaults: {},
  },
  {
    id: 'scene-slide',
    label: 'Directional slide',
    category: 'transition',
    purpose: 'decorative',
    summary: 'The screen slides in from one side.',
    staticAlternative: 'The screen appears immediately.',
    defaultReduced: 'static',
    targets: ['screen'],
    triggers: ['scene-entered'],
    requiresClip: false,
    duration: { min: 160, max: 1200, default: 420 },
    maxRepeat: 1,
    channel: 'transform',
    params: z.object({ from: z.enum(['left', 'right', 'top', 'bottom']) }).strict(),
    defaults: { from: 'right' },
  },
  {
    id: 'character-clip',
    label: 'Character clip',
    category: 'character',
    purpose: 'decorative',
    summary: 'Plays a named clip configured in the sprite-sheet editor (for example wave), then returns to its idle frame.',
    staticAlternative: 'The character stays on its idle frame.',
    defaultReduced: 'static',
    targets: ['sprite'],
    triggers: null,
    requiresClip: true,
    duration: { min: 200, max: 6000, default: 1200 },
    maxRepeat: 3,
    channel: 'sprite',
    params: z.object({ clip: clipName }).strict(),
    defaults: { clip: 'wave' },
  },
];

export const MOTION_PRESETS: Record<MotionPresetId, MotionPreset> = Object.fromEntries(PRESETS.map((p) => [p.id, p])) as Record<MotionPresetId, MotionPreset>;

export const PRESETS_BY_CATEGORY: Array<{ category: PresetCategory; presets: MotionPreset[] }> = (Object.keys(CATEGORY_LABELS) as PresetCategory[]).map((category) => ({
  category,
  presets: PRESETS.filter((p) => p.category === category),
}));

/** Things that look like motion requests but cannot be honoured with this runtime and these assets. */
export const UNAVAILABLE_EFFECTS: Array<{ id: string; label: string; reason: string; alternative: string }> = [
  { id: 'lip-sync', label: 'Lip sync / talking', reason: 'There is no speech or lip-sync generation, and no narration is invented.', alternative: 'Use an uploaded talking clip (sprite frames) and an uploaded audio file, with captions in the instruction panel.' },
  { id: 'generated-limb-motion', label: 'Waving, walking or talking from a single image', reason: 'A static image can only move, scale, fade or rotate as a whole.', alternative: 'Upload frame images or a sprite sheet and set up named clips in Assets, or use a whole-object movement.' },
  { id: 'screen-shake', label: 'Screen shake', reason: 'Excluded: shaking is disorienting and reads as punishment.', alternative: 'Use the retry outline cue.' },
  { id: 'strobe', label: 'Strobe or rapid flashing', reason: 'Excluded for safety (photosensitivity).', alternative: 'Use an outline highlight.' },
  { id: 'full-screen-confetti', label: 'Full-screen confetti', reason: 'Celebrations stay small and skippable so they never hide content.', alternative: 'Use a small particle burst or a celebration clip.' },
  { id: 'prototype-transition', label: 'Figma Smart Animate / prototype playback', reason: 'Prototype links and transitions are design evidence, not executable gameplay.', alternative: 'Choose a supported scene transition (cut, fade or slide).' },
  { id: 'generated-animation', label: 'AI-generated animation frames', reason: 'No animation-generation service is connected.', alternative: 'Draw or generate frames elsewhere, upload them, and build a sprite from them in Assets.' },
];
