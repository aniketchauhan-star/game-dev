import { z } from 'zod';
import { mechanicId, provenance } from './common.ts';

/**
 * Claude's interpretation of the deck. Every objective and activity must cite
 * `sourceSlideIds` or be explicitly marked as added practice. Nothing here is
 * presented as a quotation from the deck.
 */

const sourced = {
  sourceSlideIds: z.array(z.string()).max(40),
  addedPractice: z.boolean(),
};

export const conceptSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().max(300),
  sourceSlideIds: z.array(z.string()).max(40),
});

export const objectiveSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(240),
  ...sourced,
  /** proposed = Claude's or the sample's interpretation; verified = confirmed by the creator. */
  status: z.enum(['proposed', 'verified']),
  origin: provenance,
  locked: z.boolean(),
});
export type Objective = z.infer<typeof objectiveSchema>;

export const learningAnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  topic: z.string().min(1).max(120),
  summary: z.string().max(600),
  concepts: z.array(conceptSchema).max(20),
  prerequisites: z.array(
    z.object({ id: z.string(), text: z.string().min(1).max(200), sourceSlideIds: z.array(z.string()).max(40), inferred: z.boolean() }),
  ).max(10),
  objectives: z.array(objectiveSchema).min(1).max(12),
  examples: z.array(
    z.object({ id: z.string(), text: z.string().min(1).max(300), sourceSlideIds: z.array(z.string()).max(40), required: z.boolean() }),
  ).max(20),
  questions: z.array(
    z.object({ id: z.string(), prompt: z.string().min(1).max(240), answer: z.string().max(200), ...sourced }),
  ).max(20),
  interactions: z.array(
    z.object({ id: z.string(), mechanic: mechanicId, description: z.string().min(1).max(300), ...sourced }),
  ).max(12),
  openQuestions: z.array(z.string().max(240)).max(10),
});
export type LearningAnalysis = z.infer<typeof learningAnalysisSchema>;

export interface SourceReferenceIssue {
  path: string;
  message: string;
}

/**
 * Check that every reference points at a known (and included) slide and that
 * every objective, question and interaction is either sourced or marked as added practice.
 */
export function checkAnalysisReferences(
  analysis: LearningAnalysis,
  includedSlideIds: ReadonlySet<string>,
): SourceReferenceIssue[] {
  const issues: SourceReferenceIssue[] = [];
  const checkIds = (path: string, ids: string[]) => {
    for (const id of ids) {
      if (!includedSlideIds.has(id)) issues.push({ path, message: `Unknown or excluded slide reference "${id}"` });
    }
  };
  analysis.concepts.forEach((c, i) => checkIds(`concepts[${i}]`, c.sourceSlideIds));
  analysis.prerequisites.forEach((p, i) => checkIds(`prerequisites[${i}]`, p.sourceSlideIds));
  analysis.examples.forEach((e, i) => checkIds(`examples[${i}]`, e.sourceSlideIds));
  const sourcedLists: Array<[string, Array<{ sourceSlideIds: string[]; addedPractice: boolean }>]> = [
    ['objectives', analysis.objectives],
    ['questions', analysis.questions],
    ['interactions', analysis.interactions],
  ];
  for (const [name, list] of sourcedLists) {
    list.forEach((entry, i) => {
      checkIds(`${name}[${i}]`, entry.sourceSlideIds);
      if (entry.sourceSlideIds.length === 0 && !entry.addedPractice) {
        issues.push({ path: `${name}[${i}]`, message: 'Needs source slides or must be marked as added practice' });
      }
      if (entry.sourceSlideIds.length > 0 && entry.addedPractice) {
        issues.push({ path: `${name}[${i}]`, message: 'Cannot both cite slides and be marked as added practice' });
      }
    });
  }
  return issues;
}
