import type { DesignFrame, DesignImport } from '@shared/schemas/design.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import { GRADE_PRESETS, PRESET_DISCLAIMER, gradeLabel, type GradePlanRecord, type GradeProfileRecord } from '@shared/schemas/grade.ts';
import { MOTION_BUDGET, TRIGGER_LABELS } from '@shared/schemas/motion.ts';
import type { ScreenMapRecord } from '@shared/schemas/screens.ts';
import { describeBinding } from '@shared/motion/describe.ts';
import { listScreens } from '@shared/motion/entities.ts';
import { MOTION_PRESETS, UNAVAILABLE_EFFECTS } from '@shared/motion/presets.ts';
import { validateBindings } from '@shared/motion/validate.ts';

/**
 * Handoff files for grade versions, the Source-to-Screen map and motion.
 * They describe approved data only: no Figma documents or annotations, no
 * Claude prompts or requests, no credentials.
 */

/** Every animation in the game, as data plus its readable rule. */
export function animationManifest(config: GameConfig): object {
  const screens = listScreens(config);
  const issues = validateBindings(config);
  return {
    note: 'Animations are data in game.config.json → motion. The runtime binds them to game events; they never change scores, progress or answers.',
    settings: {
      profile: config.motion.profile,
      pacing: config.motion.pacing,
      decorativeIntensity: config.motion.decorativeIntensity,
      sound: config.motion.sound,
      soundVolume: config.motion.soundVolume,
      reducedMotion: config.motion.reducedMotion,
      lowEffects: config.motion.lowEffects,
      lockedScreens: config.motion.lockedScreens,
    },
    budgets: MOTION_BUDGET,
    screens: screens.map((s) => ({ id: s.id, label: s.label, kind: s.kind, entities: s.entities.map((e) => ({ id: e.id, label: e.label, kind: e.kind, staticImage: e.staticImage, clips: e.clips })) })),
    animations: config.motion.bindings.map((b) => ({
      id: b.id,
      rule: describeBinding(config, b),
      screenId: b.screenId,
      target: b.target,
      preset: b.presetId,
      category: MOTION_PRESETS[b.presetId].category,
      purpose: b.purpose,
      trigger: b.trigger,
      params: b.params,
      timing: b.timing,
      after: b.after,
      reducedMotion: b.reducedMotion,
      assetId: b.assetId,
      sound: b.sound,
      origin: b.origin,
      enabled: b.enabled,
      gradeProfileRevision: b.gradeProfileRevision,
    })),
    validation: issues.map((i) => ({ severity: i.severity, screenId: i.screenId, animationId: i.bindingId, message: i.message })),
  };
}

export function animationGuideMd(config: GameConfig | null): string {
  if (!config) {
    return `# ANIMATION GUIDE

There is no built game in this handoff, so there are no animations yet. Motion is added to a playable version in the studio's Animate workspace.
`;
  }
  const m = config.motion;
  const screens = listScreens(config);
  const issues = validateBindings(config);
  const lines: string[] = ['# ANIMATION GUIDE', ''];
  lines.push('Animations are **data** (`game.config.json` → `motion`), validated by `runtime-src/shared/schemas/motion.ts` and run by the trusted runtime (`runtime-src/runtime/motion/`).');
  lines.push('They are bound to runtime events (screen opened, control pressed, valid drop, correct answer, retry, completion…). Motion never submits answers, awards points, changes progress or replays sounds on its own.', '');
  lines.push('## Settings', '');
  lines.push(`- Profile: **${m.profile}** · pacing: **${m.pacing}** · decorative effects: **${m.decorativeIntensity}**`);
  lines.push(`- Animation sounds: ${m.sound ? `on (volume ${Math.round(m.soundVolume * 100)}%)` : 'off'} — uploaded or bundled audio only, after the learner presses Start`);
  lines.push(`- Reduced motion: ${m.reducedMotion === 'always' ? 'always on for everyone' : "follows the learner's device setting"} · low-effects mode: ${m.lowEffects ? 'on' : 'off'}`);
  if (m.lockedScreens.length) lines.push(`- Locked screens (motion must not change without the creator): ${m.lockedScreens.join(', ')}`);
  lines.push('');
  lines.push('## Rules by screen', '');
  for (const s of screens) {
    const list = m.bindings.filter((b) => b.screenId === s.id);
    lines.push(`### ${s.label}`, '');
    if (!list.length) {
      lines.push('_No animations._', '');
      continue;
    }
    for (const b of list) {
      lines.push(`- ${describeBinding(config, b)}${b.enabled ? '' : ' _(turned off)_'}`);
      lines.push(`  - \`${b.id}\` · ${MOTION_PRESETS[b.presetId].label} · ${b.purpose} · ${b.timing.durationMs} ms${b.timing.delayMs ? ` after ${b.timing.delayMs} ms` : ''} · reduced motion: ${b.reducedMotion} · origin: ${b.origin}`);
    }
    lines.push('');
  }
  lines.push('## Triggers', '');
  for (const [k, v] of Object.entries(TRIGGER_LABELS)) lines.push(`- \`${k}\` — when ${v}`);
  lines.push('');
  lines.push('## Runtime behaviour', '');
  lines.push('- One deterministic, cancelable scheduler per screen; everything is cancelled when the screen exits, restarts or the game is disposed, and paused while the page is hidden.');
  lines.push('- Dragging has priority: motion on a dragged object yields to the learner. Hit areas follow the objects; game state never depends on an animation finishing.');
  lines.push('- Celebrations are short and skippable; there is no strobe, flashing or screen shake.');
  lines.push(`- Budgets: at most ${MOTION_BUDGET.bindingsPerScreen} animations per screen, ${MOTION_BUDGET.bindingsPerTrigger} per trigger, ${MOTION_BUDGET.concurrentAnimations} running at once and ${MOTION_BUDGET.particlesPerBurst} particles per burst; low-effects mode removes particles.`);
  lines.push('- A single static picture only moves, fades, scales or rotates as a whole; waving or walking needs a sprite sheet with named clips.', '');
  lines.push('## Not available (by design)', '');
  for (const u of UNAVAILABLE_EFFECTS) lines.push(`- **${u.label}** — ${u.reason} Instead: ${u.alternative}`);
  lines.push('');
  lines.push('## Validation at export', '');
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  lines.push(errors.length || warnings.length ? [...errors, ...warnings].map((i) => `- ${i.severity}: ${i.message}${i.bindingId ? ` (\`${i.bindingId}\`)` : ''}`).join('\n') : `- ${m.bindings.length} animation(s) pass the target, trigger, budget and dependency checks.`);
  lines.push('');
  lines.push('No frame-rate, performance or accessibility-compliance claims are made by this export. Test on the devices learners will use, with reduced motion both on and off.');
  return lines.join('\n') + '\n';
}

const GUIDANCE = { minimal: 'Minimal', standard: 'Standard', extra: 'Extra' } as const;

export function gradeProfileMd(input: { branchName: string; profile: GradeProfileRecord | null; plans: GradePlanRecord[]; config: GameConfig | null }): string {
  const lines: string[] = ['# GRADE PROFILE', ''];
  const p = input.profile?.profile ?? null;
  lines.push(`Grade version: **${input.branchName}**${input.config ? ` (game version ${input.config.meta.versionNumber})` : ''}.`, '');
  if (!p) {
    lines.push('No grade profile was set for this version. The game uses its default settings.', '');
    return lines.join('\n') + '\n';
  }
  lines.push(`- Who it is for: **${gradeLabel(p)}**${p.curriculum ? ` · curriculum or board (as entered, not verified): ${p.curriculum}` : ''}`);
  lines.push(`- Language: ${p.language} · input: ${p.inputDevice}${p.lessonMinutes ? ` · lesson time: about ${p.lessonMinutes} min` : ''}`);
  if (p.prerequisites) lines.push(`- Prerequisites (as entered): ${p.prerequisites}`);
  lines.push(`- Profile revision ${input.profile!.revision}${p.presetId ? ` · seeded from the “${GRADE_PRESETS[p.presetId].label}” product preset` : ' · set by hand'}`, '');
  lines.push('## Separate settings', '');
  lines.push(`- Difficulty: ${p.difficulty}`);
  lines.push(`- Reading support: ${p.readingSupport} (text length, key terms and step lists — not a reading level)`);
  lines.push(`- Guidance: ${GUIDANCE[p.guidance]}`);
  lines.push(`- Motion: ${p.motion.profile}, ${p.motion.pacing} pacing, decorative ${p.motion.decorativeIntensity}, sound ${p.motion.sound ? 'on' : 'off'}`);
  lines.push(`- For everyone: low motion ${p.access.lowMotion ? 'on' : 'available'}, untimed ${p.access.untimed ? 'yes' : 'no'}, keyboard ${p.access.keyboard ? 'yes' : 'no'}, extra guidance ${p.access.extraGuidance ? 'on' : 'available'}`, '');
  lines.push(`> ${PRESET_DISCLAIMER} Nothing here infers a learner's age, ability, diagnosis or reading level.`, '');
  const applied = input.plans.filter((g) => g.status === 'applied');
  lines.push('## Grade adaptation plans applied', '');
  if (!applied.length) lines.push('- (none)');
  for (const g of applied) {
    const accepted = g.plan.items.filter((i) => g.decisions[i.id] === 'accepted');
    lines.push(`### Plan ${g.number} — ${g.mode === 'presentation' ? 'presentation only' : 'presentation + learning challenge'} (${g.origin === 'claude' ? 'Claude suggestion' : g.origin === 'demo' ? 'prepared demo answer' : 'preset rules'})`, '');
    lines.push(g.plan.summary, '');
    for (const i of accepted) lines.push(`- [${i.area}] ${i.summary}${i.addedPractice ? ' _(added practice — not in the source)_' : ''}${i.sourceSlideIds.length ? ` · source: ${i.sourceSlideIds.join(', ')}` : ''}`);
    if (g.plan.assumptions.length) lines.push('', 'Assumptions:', ...g.plan.assumptions.map((a) => `- ${a}`));
    lines.push('', `Curriculum: ${g.plan.curriculumNote || 'not checked against a curriculum (unverified).'}`, '');
  }
  return lines.join('\n') + '\n';
}

/** The Source-to-Screen map without Figma documents, annotations or slide text. */
export function designMap(input: { map: ScreenMapRecord | null; frames: Map<string, DesignFrame>; imports: Map<string, DesignImport> }): object {
  if (!input.map) return { note: 'No Source-to-Screen map was saved for this grade version.', screens: [] };
  return {
    note: 'Which lesson slides, design frames and artwork feed each game screen. Frames are listed by id, name and node only; Figma files, layer dumps and annotations are not included.',
    mapRevision: input.map.number,
    savedAt: input.map.createdAt,
    screens: input.map.mapping.screens.map((s) => ({
      screenId: s.screenId,
      kind: s.kind,
      title: s.title,
      reviewed: s.reviewed,
      slideIds: s.slideIds,
      roles: s.roles,
      designMode: s.designMode,
      fit: s.fit,
      background: s.background,
      frames: s.frames.map((l) => {
        const f = input.frames.get(l.frameId);
        const imp = f ? input.imports.get(f.importId) : undefined;
        return {
          frameId: l.frameId,
          state: l.state,
          primary: l.primary,
          name: f?.name ?? null,
          size: f ? { width: f.width, height: f.height } : null,
          source: f?.source ?? null,
          figma: imp && imp.kind === 'figma' ? { fileKey: imp.fileKey, nodeId: f?.nodeId ?? null, sourceVersion: imp.sourceVersion, lastModified: imp.lastModified } : null,
          fidelity: f ? countFidelity(f) : null,
        };
      }),
      layers: s.layers.map((l) => ({ elementId: l.elementId, use: l.use })),
      assets: s.assets,
      objects: s.objects.map((o) => ({ id: o.id, label: o.label, assetId: o.assetId, x: o.x, y: o.y, width: o.width, height: o.height, z: o.z, rotation: o.rotation, role: o.role, clip: o.clip })),
      conflicts: s.conflicts.map((c) => ({ kind: c.kind, status: c.status, message: c.message, resolution: c.resolution ? { choice: c.resolution.choice, text: c.resolution.text } : null })),
      corrections: s.corrections.length,
    })),
  };
}

function countFidelity(f: DesignFrame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of f.elements) out[e.fidelity] = (out[e.fidelity] ?? 0) + 1;
  return out;
}
