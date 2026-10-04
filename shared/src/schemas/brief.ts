import { z } from 'zod';
import { difficulty, mechanicId } from './common.ts';

export const themeId = z.enum(['ice', 'airport', 'space', 'city', 'custom']);
export type ThemeId = z.infer<typeof themeId>;

export const briefOptionsSchema = z.object({
  minimalText: z.boolean(),
  preserveSequence: z.boolean(),
  reuseArtwork: z.boolean(),
  allowAddedPractice: z.boolean(),
  reducedMotion: z.boolean(),
});
export type BriefOptions = z.infer<typeof briefOptionsSchema>;

export const gameBriefSchema = z.object({
  schemaVersion: z.literal(1),
  /** “What should learners do in your game?” */
  prompt: z.string().max(2000),
  title: z.string().max(80),
  gradeOrAge: z.string().max(40),
  subject: z.string().max(60),
  learningObjective: z.string().max(300),
  mechanic: mechanicId.nullable(),
  customIdea: z.string().max(1000),
  durationMinutes: z.number().int().min(1).max(120).nullable(),
  optional: z.object({
    story: z.string().max(600),
    difficulty,
    languageNotes: z.string().max(300),
    constraints: z.string().max(600),
    accessibilityNotes: z.string().max(400),
  }),
  visual: z.object({
    themeId,
    paletteId: z.string().max(40),
    customReferenceNote: z.string().max(400),
  }),
  options: briefOptionsSchema,
  aiInputs: z.object({
    includeSpeakerNotes: z.boolean(),
    includeHiddenSlides: z.boolean(),
    sendVisualReferences: z.boolean(),
    /** Slides whose rendered page or image the creator explicitly allowed Claude to see. */
    authorizedVisualSlideIds: z.array(z.string()).max(200),
  }),
  stage: z.object({ width: z.literal(1920), height: z.literal(1080) }),
});
export type GameBrief = z.infer<typeof gameBriefSchema>;

export function defaultBrief(): GameBrief {
  return {
    schemaVersion: 1,
    prompt: '',
    title: '',
    gradeOrAge: '',
    subject: '',
    learningObjective: '',
    mechanic: null,
    customIdea: '',
    durationMinutes: null,
    optional: { story: '', difficulty: 'standard', languageNotes: '', constraints: '', accessibilityNotes: '' },
    visual: { themeId: 'airport', paletteId: 'daylight', customReferenceNote: '' },
    options: { minimalText: true, preserveSequence: true, reuseArtwork: true, allowAddedPractice: false, reducedMotion: false },
    aiInputs: { includeSpeakerNotes: true, includeHiddenSlides: false, sendVisualReferences: false, authorizedVisualSlideIds: [] },
    stage: { width: 1920, height: 1080 },
  };
}

/** Fields the creator must fill before analysis. Returns human-readable gaps. */
export function briefGaps(brief: GameBrief): string[] {
  const gaps: string[] = [];
  if (!brief.prompt.trim()) gaps.push('Describe what learners should do in the game.');
  if (!brief.title.trim()) gaps.push('Add a working title.');
  if (!brief.gradeOrAge.trim()) gaps.push('Add the target grade or age.');
  if (!brief.subject.trim()) gaps.push('Add the subject.');
  if (!brief.learningObjective.trim()) gaps.push('Add the main learning objective.');
  if (!brief.mechanic) gaps.push('Choose a game interaction.');
  if (brief.mechanic === 'custom' && !brief.customIdea.trim()) gaps.push('Describe your custom game idea.');
  return gaps;
}
