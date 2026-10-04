import type { LearningAnalysis } from './schemas/analysis.ts';
import type { Blueprint } from './schemas/blueprint.ts';
import type { Coverage } from './schemas/records.ts';

interface SlideLike {
  id: string;
  slideNumber: number;
  hidden: boolean;
  included: boolean;
  title: string;
}

/**
 * Which included slides (and concepts) feed which scenes. Explains exclusions
 * and duplicates instead of hiding them.
 */
export function computeCoverage(
  slides: SlideLike[],
  blueprint: Blueprint | null,
  analysis: LearningAnalysis | null,
  blueprintRevisionId: string | null,
): Coverage {
  const scenesBySlide = new Map<string, string[]>();
  for (const scene of blueprint?.scenes ?? []) {
    for (const sid of new Set(scene.sourceSlideIds)) {
      const list = scenesBySlide.get(sid) ?? [];
      list.push(scene.id);
      scenesBySlide.set(sid, list);
    }
  }
  const conceptsBySlide = new Map<string, string[]>();
  for (const c of analysis?.concepts ?? []) {
    for (const sid of new Set(c.sourceSlideIds)) {
      const list = conceptsBySlide.get(sid) ?? [];
      list.push(c.id);
      conceptsBySlide.set(sid, list);
    }
  }
  const number = new Map(slides.map((s) => [s.id, s.slideNumber]));

  const slideRows = slides.map((s) => {
    const sceneIds = scenesBySlide.get(s.id) ?? [];
    let status: Coverage['slides'][number]['status'];
    let note: string | null = null;
    if (!s.included && s.hidden) {
      status = 'hidden';
      note = 'Hidden in the deck and excluded by default. Include it in Source review to use it.';
    } else if (!s.included) {
      status = 'excluded';
      note = 'Excluded by the creator.';
    } else if (sceneIds.length > 0) {
      status = 'covered';
      if (sceneIds.length > 1) note = `Used by ${sceneIds.length} scenes.`;
    } else {
      status = 'not-covered';
      note = blueprint ? 'Included but not used by any scene.' : 'No blueprint yet.';
    }
    return { slideId: s.id, slideNumber: s.slideNumber, title: s.title, status, sceneIds, conceptIds: conceptsBySlide.get(s.id) ?? [], note };
  });

  const scenes = (blueprint?.scenes ?? []).map((sc) => ({
    sceneId: sc.id,
    title: sc.title,
    slideNumbers: sc.sourceSlideIds.map((id) => number.get(id)).filter((n): n is number => n !== undefined),
    addedPractice: sc.addedPractice,
  }));

  const duplicates = slideRows
    .filter((r) => r.sceneIds.length > 1)
    .map((r) => ({ slideId: r.slideId, slideNumber: r.slideNumber, sceneIds: r.sceneIds }));

  const concepts = (analysis?.concepts ?? []).map((c) => {
    const sceneIds = new Set<string>();
    for (const sid of c.sourceSlideIds) for (const sc of scenesBySlide.get(sid) ?? []) sceneIds.add(sc);
    return { conceptId: c.id, name: c.name, slideIds: c.sourceSlideIds, sceneIds: [...sceneIds] };
  });

  const included = slideRows.filter((r) => r.status === 'covered' || r.status === 'not-covered').length;
  return {
    blueprintRevisionId,
    slides: slideRows,
    scenes,
    duplicates,
    concepts,
    summary: {
      included,
      covered: slideRows.filter((r) => r.status === 'covered').length,
      notCovered: slideRows.filter((r) => r.status === 'not-covered').length,
      excluded: slideRows.filter((r) => r.status === 'excluded' || r.status === 'hidden').length,
      addedPracticeScenes: scenes.filter((s) => s.addedPractice).length,
    },
  };
}
