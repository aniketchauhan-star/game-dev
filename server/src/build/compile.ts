import { checkInteraction } from '@shared/attainability.ts';
import { sceneFlow, type BlueprintRevision } from '@shared/schemas/blueprint.ts';
import type { GameBrief } from '@shared/schemas/brief.ts';
import { gameConfigSchema, RUNTIME_VERSION, type GameAsset, type GameConfig, type GameScene } from '@shared/schemas/game.ts';
import { toGameAsset } from '@shared/assetsToGame.ts';
import type { BuildableInteraction } from '@shared/schemas/interaction.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import type { Asset } from '@shared/schemas/assets.ts';
import { gradeLabel, type GradeProfile } from '@shared/schemas/grade.ts';
import { DEFAULT_MOTION_CONFIG, type MotionConfig } from '@shared/schemas/motion.ts';
import type { SourceScreenMapping } from '@shared/schemas/screens.ts';
import { computeScreenLayout, type LayoutContext } from '@shared/screens/layout.ts';
import { validateBindings } from '@shared/motion/validate.ts';
import { isBuildableSceneType, UNSUPPORTED_MESSAGE } from '@shared/registry.ts';
import { hashString } from '@shared/rng.ts';
import { findPalette, THEME_PRESETS } from '@shared/themes.ts';

/**
 * Deterministic compiler: approved blueprint revision → GameConfig. No AI call
 * happens here; the same revision and assets always produce the same game.
 */

export interface CompileResult {
  config: GameConfig | null;
  errors: string[];
  warnings: string[];
}

const COMPLETION_HEADINGS: Record<string, string> = {
  airport: 'Mission complete',
  space: 'Mission complete',
  ice: 'Expedition complete',
  city: 'Route complete',
  custom: 'Well done',
};

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

export interface CompileExtras {
  /** Grade version the build belongs to. */
  branchId?: string | null;
  /** Reviewed Source-to-Screen map with the frames and assets it refers to. */
  screenMap?: { number: number; mapping: SourceScreenMapping; ctx: LayoutContext } | null;
  /** Grade & learning profile in force for this build. */
  grade?: { revision: number; profile: GradeProfile } | null;
  /** Approved motion of the previous version, kept where its screens and targets still exist. */
  carryMotion?: MotionConfig | null;
}

export function compileGame(input: {
  projectId: string;
  revision: BlueprintRevision;
  brief: GameBrief;
  assets: Asset[];
  slides: SourceSlide[];
} & CompileExtras): CompileResult {
  const { revision, brief } = input;
  const blueprint = revision.blueprint;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (revision.status === 'draft') errors.push(`Blueprint r${revision.number} is a draft. Approve it before building.`);
  if (revision.stale) warnings.push(`Blueprint r${revision.number} is marked stale: ${revision.staleReason ?? 'the source changed after approval'}.`);

  const assetById = new Map(input.assets.map((a) => [a.id, a]));
  const needById = new Map(blueprint.assetNeeds.map((n) => [n.id, n]));
  const usedAssets = new Map<string, GameAsset>();
  const useAsset = (assetId: string | null | undefined, purpose: string, kind: 'image' | 'audio'): string | null => {
    if (!assetId) return null;
    const a = assetById.get(assetId);
    if (!a) {
      warnings.push(`${purpose}: assigned asset ${assetId} is missing from the library; built-in artwork is used instead.`);
      return null;
    }
    if (a.kind !== kind) {
      warnings.push(`${purpose}: asset “${a.name}” is ${a.kind}, not ${kind}; it was not used.`);
      return null;
    }
    if (!usedAssets.has(a.id)) usedAssets.set(a.id, toGameAsset(a));
    return a.id;
  };
  const needAsset = (needId: string | null, purpose: string): string | null => {
    if (!needId) return null;
    const need = needById.get(needId);
    if (!need) return null;
    if (!need.assignedAssetId) {
      if (need.required) warnings.push(`${purpose}: “${need.description}” has no asset assigned; built-in artwork is used.`);
      return null;
    }
    return useAsset(need.assignedAssetId, purpose, need.role === 'audio' ? 'audio' : 'image');
  };

  const preset = THEME_PRESETS[brief.visual.themeId];
  const palette = findPalette(brief.visual.themeId, brief.visual.paletteId);
  const backgroundNeed = blueprint.assetNeeds.find((n) => n.role === 'background' && n.assignedAssetId);
  const characterNeed = blueprint.assetNeeds.find((n) => n.role === 'character' && n.assignedAssetId);
  const musicNeed = blueprint.assetNeeds.find((n) => n.role === 'audio' && n.assignedAssetId);

  const lockedSlides = new Set(input.slides.filter((s) => s.lockedWording).map((s) => s.id));
  const ordered = sceneFlow(blueprint.scenes);
  if (ordered.length !== blueprint.scenes.length) warnings.push('Some scenes are not reachable from the first scene and were left out.');

  const scenes: GameScene[] = [];
  for (const [index, scene] of ordered.entries()) {
    const label = `Scene ${index + 1} “${scene.title}”`;
    if (!isBuildableSceneType(scene.interaction.type)) {
      errors.push(`${label}: ${UNSUPPORTED_MESSAGE}`);
      continue;
    }
    let interaction = scene.interaction as BuildableInteraction;
    const seed = hashString(`${input.projectId}:${revision.number}`) & 0x7fffffff;
    for (const issue of checkInteraction(interaction, { seed, sceneId: scene.id })) {
      (issue.severity === 'error' ? errors : warnings).push(`${label}: ${issue.message}`);
    }
    // Card images keep only ids that were actually packaged; anything else falls back to text-only cards.
    const withImage = <T extends { label: string; imageAssetId: string | null }>(card: T): T =>
      card.imageAssetId ? { ...card, imageAssetId: useAsset(card.imageAssetId, `${label} card “${card.label}”`, 'image') } : card;
    if (interaction.type === 'drag-match') interaction = { ...interaction, items: interaction.items.map(withImage), targets: interaction.targets.map(withImage) };
    else if (interaction.type === 'sequence-sort') interaction = { ...interaction, items: interaction.items.map(withImage) };
    let character = needAsset(scene.assetNeedIds.character, `${label} character`);
    if (!character && interaction.type === 'coordinate-navigation' && characterNeed) character = needAsset(characterNeed.id, `${label} character`);
    scenes.push({
      id: scene.id,
      title: scene.title,
      pattern: scene.pattern,
      sourceSlideIds: scene.sourceSlideIds,
      addedPractice: scene.addedPractice,
      instruction: scene.instruction,
      supportText: null,
      layout: { instructionPosition: 'top', density: 'comfortable', showProgress: true },
      interaction,
      feedback: { success: scene.successFeedback, error: scene.errorFeedback, hints: scene.hints },
      assets: { background: needAsset(scene.assetNeedIds.background, `${label} background`), character, characterClip: null, panel: null, button: null },
      design: null,
      objects: [],
      next: null,
      locks: { ...scene.locks, wording: scene.locks.wording || scene.sourceSlideIds.some((id) => lockedSlides.has(id)) },
    });
  }
  scenes.forEach((s, i) => (s.next = scenes[i + 1]?.id ?? null));
  if (scenes.length === 0) errors.push('The blueprint has no buildable scenes.');
  if (errors.length > 0) return { config: null, errors, warnings };

  const outcomes = blueprint.learningOutcomes.map((o) => o.text.replace(/\.$/, '')).slice(0, 2);
  const config: GameConfig = {
    schemaVersion: 1,
    kind: 'nexus-game',
    id: 'pending',
    title: blueprint.title,
    language: 'en',
    meta: {
      projectId: input.projectId,
      versionNumber: 0,
      blueprintRevisionId: revision.id,
      blueprintRevisionNumber: revision.number,
      builtAt: new Date().toISOString(),
      origin: 'build',
      demo: revision.origin === 'demo',
      runtimeVersion: RUNTIME_VERSION,
      branchId: input.branchId ?? null,
      gradeLabel: input.grade ? gradeLabel(input.grade.profile) : '',
      gradeProfileRevision: input.grade?.revision ?? null,
      screenMapNumber: input.screenMap?.number ?? null,
    },
    stage: { width: 1920, height: 1080 },
    theme: {
      presetId: preset.id,
      paletteId: palette.id,
      palette: palette.palette,
      decor: preset.decor,
      backgroundAssetId: backgroundNeed ? useAsset(backgroundNeed.assignedAssetId, 'Game background', 'image') : null,
      fontStyle: preset.fontStyle,
    },
    settings: {
      minimalText: brief.options.minimalText,
      reducedMotion: brief.options.reducedMotion,
      seed: hashString(`${input.projectId}:${revision.number}`) & 0x7fffffff,
      audio: { sfx: input.grade ? input.grade.profile.motion.sound : true, musicAssetId: musicNeed ? useAsset(musicNeed.assignedAssetId, 'Background music', 'audio') : null },
      locks: { sequence: brief.options.preserveSequence, assetIdentity: brief.options.reuseArtwork },
      guidance: input.grade ? (input.grade.profile.access.extraGuidance ? 'extra' : input.grade.profile.guidance) : 'standard',
    },
    screens: {
      title: {
        heading: clip(blueprint.title, 80),
        subheading: clip(blueprint.premise, 160),
        startLabel: 'Start',
        characterAssetId: characterNeed ? useAsset(characterNeed.assignedAssetId, 'Title character', 'image') : null,
        characterClip: null,
        design: null,
        objects: [],
      },
      completion: {
        heading: COMPLETION_HEADINGS[preset.id] ?? 'Well done',
        message: clip(outcomes.length ? `Skills practised: ${outcomes.join('; ')}.` : 'You finished every scene.', 240),
        replayLabel: 'Play again',
        characterAssetId: null,
        characterClip: null,
        design: null,
        objects: [],
      },
    },
    assets: Object.fromEntries(usedAssets),
    scenes,
    motion: structuredClone(DEFAULT_MOTION_CONFIG),
  };
  if (input.grade) {
    const p = input.grade.profile;
    config.settings.reducedMotion = config.settings.reducedMotion || p.access.lowMotion;
    config.motion = {
      ...config.motion,
      profile: p.motion.profile,
      pacing: p.motion.pacing,
      decorativeIntensity: p.access.lowMotion ? 'off' : p.motion.decorativeIntensity,
      sound: p.motion.sound,
      reducedMotion: p.access.lowMotion ? 'always' : 'follow-device',
    };
  }

  // Screen map: design layout, placed objects, exact artwork and (where chosen) Figma or creator wording.
  if (input.screenMap) {
    const lockedWording = new Set(scenes.filter((s) => s.locks.wording).map((s) => s.id));
    for (const entry of input.screenMap.mapping.screens) {
      const target = entry.screenId === 'title' ? config.screens.title : entry.screenId === 'completion' ? config.screens.completion : scenes.find((s) => s.id === entry.screenId);
      if (!target) {
        warnings.push(`Screen map row “${entry.title}” has no matching scene in blueprint r${revision.number}; it was skipped.`);
        continue;
      }
      const r = computeScreenLayout(entry, input.screenMap.ctx);
      warnings.push(...r.warnings);
      const keep = (id: string | null | undefined, what: string): string | null => (id ? useAsset(id, `${entry.title} ${what}`, 'image') : null);
      const l = r.layout;
      if (l.design) {
        target.design = {
          ...l.design,
          backgroundAssetId: keep(l.design.backgroundAssetId, 'background'),
          layers: l.design.layers.filter((layer) => layer.kind !== 'image' || keep(layer.assetId, `layer “${layer.name}”`) !== null),
        };
      }
      target.objects = l.objects.filter((o) => keep(o.assetId, `object “${o.label}”`) !== null);
      if ('assets' in target) {
        if (l.character !== undefined) target.assets.character = keep(l.character, 'character');
        if (l.characterClip !== undefined) target.assets.characterClip = target.assets.character ? (l.characterClip ?? null) : null;
        if (l.background !== undefined) target.assets.background = keep(l.background, 'background');
        target.assets.panel = keep(l.panel, 'panel');
        target.assets.button = keep(l.button, 'buttons');
        const scene = target as GameScene;
        if (r.wording.instruction || r.wording.title) {
          if (lockedWording.has(scene.id)) warnings.push(`“${scene.title}”: wording is locked to the source slides, so the ${entry.roles.content === 'figma' ? 'Figma' : 'creator'} wording was not used.`);
          else {
            if (r.wording.instruction) scene.instruction = clip(r.wording.instruction, 300);
            if (r.wording.title) scene.title = clip(r.wording.title, 60);
          }
        }
      } else {
        if (l.character !== undefined) target.characterAssetId = keep(l.character, 'character');
        if (l.characterClip !== undefined) target.characterClip = target.characterAssetId ? (l.characterClip ?? null) : null;
      }
    }
  }

  // Keep approved motion where its screens and targets still exist; anything else is reported, never silently changed.
  if (input.carryMotion) {
    config.motion = { ...input.carryMotion, bindings: [] };
    const draft = { ...config, assets: Object.fromEntries(usedAssets) } as GameConfig;
    for (const b of input.carryMotion.bindings) {
      for (const id of [b.assetId, b.sound?.assetId]) if (id) useAsset(id, `Animation “${b.label || b.id}”`, assetById.get(id)?.kind === 'audio' ? 'audio' : 'image');
    }
    const kept: MotionConfig['bindings'] = [];
    for (const b of input.carryMotion.bindings) {
      const issues = validateBindings({ ...draft, assets: Object.fromEntries(usedAssets) } as GameConfig, [...kept, b]).filter((i) => i.severity === 'error' && (i.bindingId === b.id || i.bindingId === null));
      if (issues.length) warnings.push(`Animation “${b.label || b.id}” was not carried over: ${issues[0]!.message}`);
      else kept.push(b);
    }
    config.motion.bindings = kept;
    config.motion.lockedScreens = config.motion.lockedScreens.filter((id) => id === 'title' || id === 'completion' || scenes.some((s) => s.id === id));
  }

  config.assets = Object.fromEntries(usedAssets);
  const parsed = gameConfigSchema.safeParse(config);
  if (!parsed.success) {
    return { config: null, errors: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`), warnings };
  }
  return { config: parsed.data, errors, warnings };
}
