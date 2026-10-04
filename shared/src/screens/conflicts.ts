import { overlap, tokens } from '../similarity.ts';
import type { SourceConflict } from '../schemas/screens.ts';

/**
 * Rule-based checks for disagreements between the lesson deck (PowerPoint) and
 * design text (Figma). They only flag; they never pick a winner. Each check is
 * deliberately narrow so a flag means something:
 *
 *   definition   the same term defined with different quantities
 *                (“exactly one pair” vs “at least one pair”)
 *   answer-rule  near-identical statements with opposite polarity
 *                (“parallelograms are trapeziums” vs “… are not …”)
 *   number       near-identical statements with different numbers
 *   label        a design label that nearly matches a game label but differs
 *                (“Kites” vs “Kite”)
 */

export interface TextSource {
  text: string;
  /** Slide ids (PowerPoint) or frame + element ids (Figma). */
  slideIds?: string[];
  frameId?: string | null;
  elementId?: string | null;
}

const NUMBER_WORDS: Record<string, number> = { no: 0, zero: 0, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

interface Claim {
  subject: string;
  object: string;
  quantity: string;
  sentence: string;
}

function singular(w: string): string {
  return w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** “A trapezium has exactly one pair of parallel sides” → { trapezium, pair, =1 }. */
export function definitionClaims(text: string): Claim[] {
  const out: Claim[] = [];
  const re = /\b(?:an?|the|every|each)\s+([a-z]+)\s+(?:is\s+an?\s+[a-z]+\s+(?:with|that\s+has|having)|has|have|contains|must\s+have)\s+(exactly|only|at\s+least|at\s+most|no|\d+|one|two|three|four|five|six|a\s+single)\s*(\d+|one|two|three|four|five|six)?\s+([a-z]+)/gi;
  for (const s of sentences(text)) {
    for (const m of s.toLowerCase().matchAll(re)) {
      const subject = singular(m[1]!);
      const q1 = m[2]!.replace(/\s+/g, ' ');
      const q2 = m[3] ?? null;
      const object = singular(m[4]!);
      const n = q2 !== null ? (NUMBER_WORDS[q2] ?? Number(q2)) : q1 === 'a single' ? 1 : (NUMBER_WORDS[q1] ?? (Number.isFinite(Number(q1)) ? Number(q1) : NaN));
      if (!Number.isFinite(n)) continue;
      const op = q1 === 'at least' ? '>=' : q1 === 'at most' ? '<=' : '=';
      out.push({ subject, object, quantity: `${op}${n}`, sentence: s });
    }
  }
  return out;
}

const NEGATION = /\b(not|never|no|isn't|aren't|cannot|can't|doesn't|don't)\b/i;
const numbersIn = (s: string) => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).join(',');

export function detectConflicts(ppt: TextSource[], figma: TextSource[], gameLabels: string[] = []): Array<Omit<SourceConflict, 'id' | 'status' | 'resolution'>> {
  const found: Array<Omit<SourceConflict, 'id' | 'status' | 'resolution'>> = [];
  const seen = new Set<string>();
  const add = (c: Omit<SourceConflict, 'id' | 'status' | 'resolution'>) => {
    const key = `${c.kind}|${c.pptText}|${c.figmaText}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(c);
  };

  for (const f of figma) {
    const fClaims = definitionClaims(f.text);
    for (const p of ppt) {
      for (const fc of fClaims) {
        for (const pc of definitionClaims(p.text)) {
          if (fc.subject === pc.subject && fc.object === pc.object && fc.quantity !== pc.quantity) {
            add({
              kind: 'definition',
              pptText: pc.sentence.slice(0, 800),
              pptSlideIds: (p.slideIds ?? []).slice(0, 6),
              figmaText: fc.sentence.slice(0, 800),
              figmaFrameId: f.frameId ?? null,
              figmaElementId: f.elementId ?? null,
              message: `The design defines “${fc.subject}” differently from the lesson (${fc.quantity.replace('>=', 'at least ').replace('<=', 'at most ').replace('=', 'exactly ')} vs ${pc.quantity.replace('>=', 'at least ').replace('<=', 'at most ').replace('=', 'exactly ')} ${pc.object}).`,
              detectedBy: 'rule',
            });
          }
        }
      }
      // Near-identical statements that disagree on polarity or numbers.
      for (const fs of sentences(f.text)) {
        const ft = tokens(fs);
        if (ft.size < 3) continue;
        for (const ps of sentences(p.text)) {
          const o = overlap(ft, tokens(ps));
          if (o.shared < 3 || o.score < 0.6) continue;
          if (NEGATION.test(fs) !== NEGATION.test(ps)) {
            add({
              kind: 'answer-rule',
              pptText: ps.slice(0, 800),
              pptSlideIds: (p.slideIds ?? []).slice(0, 6),
              figmaText: fs.slice(0, 800),
              figmaFrameId: f.frameId ?? null,
              figmaElementId: f.elementId ?? null,
              message: 'The design and the lesson make opposite statements about the same thing.',
              detectedBy: 'rule',
            });
          } else if (numbersIn(fs) !== numbersIn(ps) && (numbersIn(fs) || numbersIn(ps))) {
            add({
              kind: 'number',
              pptText: ps.slice(0, 800),
              pptSlideIds: (p.slideIds ?? []).slice(0, 6),
              figmaText: fs.slice(0, 800),
              figmaFrameId: f.frameId ?? null,
              figmaElementId: f.elementId ?? null,
              message: 'The design and the lesson use different numbers in the same statement.',
              detectedBy: 'rule',
            });
          }
        }
      }
    }
    // Labels: short design texts that nearly match a game label.
    const short = f.text.trim();
    if (short.length > 0 && short.length <= 40 && short.split(/\s+/).length <= 3) {
      for (const label of gameLabels) {
        const a = short.toLowerCase();
        const b = label.trim().toLowerCase();
        if (a !== b && (singular(a) === singular(b) || editDistance(a, b) === 1)) {
          add({
            kind: 'label',
            pptText: label.slice(0, 800),
            pptSlideIds: [],
            figmaText: short,
            figmaFrameId: f.frameId ?? null,
            figmaElementId: f.elementId ?? null,
            message: `The design labels this “${short}”; the game uses “${label}”.`,
            detectedBy: 'rule',
          });
        }
      }
    }
  }
  return found.slice(0, 40);
}

export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}
