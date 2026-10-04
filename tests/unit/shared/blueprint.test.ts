import { describe, expect, it } from 'vitest';
import {
  blueprintSchema,
  checkBlueprint,
  isNotWritten,
  NOT_WRITTEN,
  relinkLinear,
  sceneFlow,
  type Blueprint,
  type BlueprintIssue,
  type BlueprintScene,
} from '@shared/schemas/blueprint.ts';
import { briefGaps, defaultBrief, gameBriefSchema } from '@shared/schemas/brief.ts';
import { deepFreeze, loadSampleBlueprint, loadSampleBrief, makeBlueprint, makeBlueprintScene, sampleCitedPptxIds, sampleSlideId } from './helpers.ts';

const INCLUDED = new Set(['sld_slide0001', 'sld_slide0002', 'sld_slide0003']);

/** Linear blueprint a → b → c over the included slides. */
function linear(overrides: Partial<Record<'a' | 'b' | 'c', Partial<BlueprintScene>>> = {}, blueprint: Partial<Blueprint> = {}): Blueprint {
  const scenes = relinkLinear([
    makeBlueprintScene('scn_a', { sourceSlideIds: ['sld_slide0001'] }),
    makeBlueprintScene('scn_b', { sourceSlideIds: ['sld_slide0002'] }),
    makeBlueprintScene('scn_c', { sourceSlideIds: ['sld_slide0003'] }),
  ]).map((s) => ({ ...s, ...overrides[s.id.slice(4) as 'a' | 'b' | 'c'] }));
  return makeBlueprint(scenes, blueprint);
}

const errorsOf = (issues: BlueprintIssue[]) => issues.filter((i) => i.severity === 'error');
const warningsOf = (issues: BlueprintIssue[]) => issues.filter((i) => i.severity === 'warning');

describe('checkBlueprint', () => {
  it('finds no issues in the sample blueprint when every cited slide is included', () => {
    const blueprint = loadSampleBlueprint();
    const included = new Set(sampleCitedPptxIds().map(sampleSlideId));
    expect(checkBlueprint(blueprint, included)).toEqual([]);
  });

  it('finds no issues in a well-formed linear blueprint', () => {
    const blueprint = linear();
    expect(blueprintSchema.safeParse(blueprint).success).toBe(true);
    expect(checkBlueprint(blueprint, INCLUDED)).toEqual([]);
  });

  it('reports duplicate scene ids', () => {
    const blueprint = linear({ c: { id: 'scn_a', next: null } });
    expect(errorsOf(checkBlueprint(blueprint, INCLUDED))).toContainEqual({ sceneId: 'scn_a', severity: 'error', message: 'Duplicate scene id "scn_a"' });
  });

  it('reports slides that are unknown or excluded', () => {
    const blueprint = linear({ b: { sourceSlideIds: ['sld_slide0002', 'sld_ghost001'] } });
    expect(checkBlueprint(blueprint, INCLUDED)).toEqual([{ sceneId: 'scn_b', severity: 'error', message: 'References unknown or excluded slide "sld_ghost001"' }]);
    // The same slide becomes an error once the creator excludes it.
    const withoutSlide2 = new Set([...INCLUDED].filter((id) => id !== 'sld_slide0002'));
    expect(checkBlueprint(linear(), withoutSlide2)).toEqual([{ sceneId: 'scn_b', severity: 'error', message: 'References unknown or excluded slide "sld_slide0002"' }]);
  });

  it('reports learning outcomes that cite excluded slides or have no sources', () => {
    const blueprint = linear(
      {},
      {
        learningOutcomes: [
          { id: 'out-1', text: 'Plot points from ordered pairs.', sourceSlideIds: ['sld_hidden01'], addedPractice: false },
          { id: 'out-2', text: 'Name the quadrant of any point quickly.', sourceSlideIds: [], addedPractice: false },
          { id: 'out-3', text: 'Practise extra examples.', sourceSlideIds: [], addedPractice: true },
        ],
      },
    );
    expect(checkBlueprint(blueprint, INCLUDED)).toEqual([
      { sceneId: null, severity: 'error', message: 'Outcome references unknown or excluded slide "sld_hidden01"' },
      { sceneId: null, severity: 'error', message: 'Outcome “Name the quadrant of any point quickly.” needs source slides or must be marked as added practice' },
    ]);
  });

  it('reports scenes without source slides unless they are marked as added practice', () => {
    const unsourced = linear({ c: { sourceSlideIds: [] } });
    expect(checkBlueprint(unsourced, INCLUDED)).toEqual([
      { sceneId: 'scn_c', severity: 'error', message: 'Scene needs source slides or must be marked as added practice' },
    ]);
    expect(checkBlueprint(linear({ c: { sourceSlideIds: [], addedPractice: true } }), INCLUDED)).toEqual([]);
  });

  it('reports unknown asset needs', () => {
    const blueprint = linear({ a: { assetNeedIds: { background: 'bg-main', character: 'char-ghost' } } });
    expect(checkBlueprint(blueprint, INCLUDED)).toEqual([{ sceneId: 'scn_a', severity: 'error', message: 'Unknown asset need "char-ghost"' }]);
  });

  it('reports next pointers to unknown scenes', () => {
    const blueprint = linear({ c: { next: 'scn_ghost' } });
    expect(checkBlueprint(blueprint, INCLUDED)).toEqual([{ sceneId: 'scn_c', severity: 'error', message: '“Next scene” points to unknown scene "scn_ghost"' }]);
  });

  it('reports a scene that leads to itself', () => {
    const blueprint = linear({ c: { next: 'scn_c' } });
    expect(checkBlueprint(blueprint, INCLUDED)).toEqual([
      { sceneId: 'scn_c', severity: 'error', message: 'A scene cannot lead to itself' },
      { sceneId: 'scn_c', severity: 'error', message: 'Scene flow contains a loop' },
    ]);
  });

  it('reports a loop in the scene flow at the scene where it closes', () => {
    const blueprint = linear({ c: { next: 'scn_b' } });
    expect(checkBlueprint(blueprint, INCLUDED)).toEqual([{ sceneId: 'scn_b', severity: 'error', message: 'Scene flow contains a loop' }]);
  });

  it('warns (not errors) about scenes that cannot be reached from the first scene', () => {
    const blueprint = linear({ b: { next: null } });
    expect(checkBlueprint(blueprint, INCLUDED)).toEqual([{ sceneId: 'scn_c', severity: 'warning', message: 'Scene is not reachable from the first scene' }]);
  });

  it('treats an unwritten premise as an error', () => {
    const issues = checkBlueprint(linear({}, { premise: NOT_WRITTEN }), INCLUDED);
    expect(issues).toEqual([{ sceneId: null, severity: 'error', message: 'Write the story premise — learners see it on the title screen.' }]);
  });

  it('treats unwritten mechanic fit, progression and assessment as warnings', () => {
    const issues = checkBlueprint(linear({}, { mechanicFit: NOT_WRITTEN, progression: `${NOT_WRITTEN}.`, assessment: `  ${NOT_WRITTEN} — add the checks` }), INCLUDED);
    expect(errorsOf(issues)).toEqual([]);
    expect(warningsOf(issues).map((i) => i.message)).toEqual([
      '“Why this mechanic fits” is not written yet — it goes into the design document and exports.',
      'Progression is not written yet — it goes into the design document and exports.',
      'Assessment is not written yet — it goes into the design document and exports.',
    ]);
    expect(warningsOf(issues).every((i) => i.sceneId === null)).toBe(true);
  });

  it('collects several independent problems at once', () => {
    const blueprint = linear({ a: { sourceSlideIds: [] }, b: { assetNeedIds: { background: 'bg-ghost', character: null } }, c: { next: 'scn_zz' } }, { premise: NOT_WRITTEN });
    expect(errorsOf(checkBlueprint(blueprint, INCLUDED))).toHaveLength(4);
  });

  it('does not mutate the blueprint', () => {
    const blueprint = deepFreeze(linear({ c: { next: 'scn_b' } }));
    expect(() => checkBlueprint(blueprint, INCLUDED)).not.toThrow();
  });
});

describe('isNotWritten', () => {
  it('recognises the placeholder at the start of the text, ignoring surrounding whitespace', () => {
    expect(isNotWritten(NOT_WRITTEN)).toBe(true);
    expect(isNotWritten(`   ${NOT_WRITTEN}: describe the story`)).toBe(true);
    expect(isNotWritten('A real premise.')).toBe(false);
    expect(isNotWritten(`The text says ${NOT_WRITTEN}`)).toBe(false);
    expect(isNotWritten('')).toBe(false);
  });
});

describe('relinkLinear and sceneFlow', () => {
  const node = (id: string, next: string | null) => ({ id, next });

  it('relinkLinear points each scene at the next one in array order without mutating the input', () => {
    const input = deepFreeze([node('c', 'a'), node('a', null), node('b', 'c')]);
    expect(relinkLinear(input)).toEqual([node('c', 'a'), node('a', 'b'), node('b', null)]);
    expect(relinkLinear([])).toEqual([]);
  });

  it('sceneFlow follows next pointers from the first scene', () => {
    expect(sceneFlow([node('a', 'c'), node('b', null), node('c', 'b')]).map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('sceneFlow leaves out unreachable scenes and stops at loops and unknown ids', () => {
    expect(sceneFlow([node('a', 'b'), node('b', null), node('c', 'a')]).map((s) => s.id)).toEqual(['a', 'b']);
    expect(sceneFlow([node('a', 'b'), node('b', 'a'), node('c', null)]).map((s) => s.id)).toEqual(['a', 'b']);
    expect(sceneFlow([node('a', 'ghost'), node('b', null)]).map((s) => s.id)).toEqual(['a']);
    expect(sceneFlow([])).toEqual([]);
  });
});

describe('briefGaps', () => {
  it('lists every required field of an empty brief', () => {
    expect(briefGaps(defaultBrief())).toEqual([
      'Describe what learners should do in the game.',
      'Add a working title.',
      'Add the target grade or age.',
      'Add the subject.',
      'Add the main learning objective.',
      'Choose a game interaction.',
    ]);
  });

  it('finds no gaps in the sample brief', () => {
    expect(briefGaps(loadSampleBrief())).toEqual([]);
  });

  it('treats whitespace-only answers as missing', () => {
    const brief = { ...loadSampleBrief(), title: '   ', subject: '\n\t' };
    expect(briefGaps(brief)).toEqual(['Add a working title.', 'Add the subject.']);
  });

  it('requires a description for a custom game idea', () => {
    const custom = { ...loadSampleBrief(), mechanic: 'custom' as const, customIdea: ' ' };
    expect(briefGaps(custom)).toEqual(['Describe your custom game idea.']);
    expect(briefGaps({ ...custom, customIdea: 'A timed memory game.' })).toEqual([]);
  });

  it('the default brief is schema-valid', () => {
    expect(gameBriefSchema.safeParse(defaultBrief()).success).toBe(true);
  });
});
