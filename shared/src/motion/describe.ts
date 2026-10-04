import type { GameConfig } from '../schemas/game.ts';
import type { AnimationBinding } from '../schemas/motion.ts';
import { listScreens } from './entities.ts';
import { MOTION_PRESETS } from './presets.ts';

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function when(b: AnimationBinding, screenLabel: string, entityLabel: (id: string) => string): string {
  const t = b.trigger;
  switch (t.event) {
    case 'scene-entered':
      return `When ${screenLabel} opens`;
    case 'control-activated':
      return `When the ${t.control ?? 'chosen'} button is pressed on ${screenLabel}`;
    case 'instruction-advanced':
      return `When the next hint or step is shown on ${screenLabel}`;
    case 'object-selected':
      return `When ${t.entity ? entityLabel(t.entity) : 'an object'} is selected on ${screenLabel}`;
    case 'valid-drop':
      return `When an object lands on ${t.entity ? entityLabel(t.entity) : 'a valid target'} on ${screenLabel}`;
    case 'correct-answer':
      return `After the correct answer on ${screenLabel}`;
    case 'retry-requested':
      return `When an answer on ${screenLabel} is not right yet`;
    case 'scene-completed':
      return `When ${screenLabel} is completed`;
  }
}

function effect(b: AnimationBinding, target: string, entityLabel: (id: string) => string): string {
  const p = b.params;
  const rep = times(b.timing.repeat);
  switch (b.presetId) {
    case 'fade-in':
      return `fade in ${target}`;
    case 'slide-in':
      return `slide ${target} in from the ${String(p.from ?? 'left')}`;
    case 'pop-in':
      return `pop ${target} into view`;
    case 'outline-highlight':
      return `highlight ${target} with an outline`;
    case 'label-reveal':
      return `reveal ${target} step by step`;
    case 'path-reveal':
      return `draw an arrow from ${target} to ${entityLabel(String(p.to ?? ''))}`;
    case 'attention-cue':
      return `give ${target} one gentle attention cue`;
    case 'move-to':
      return typeof p.to === 'string' ? `move ${target} to ${entityLabel(p.to)}` : `move ${target} to (${Math.round(Number(p.x))}, ${Math.round(Number(p.y))})`;
    case 'move-by': {
      const units = p.units === 'grid' ? 'units' : 'px';
      const dx = Number(p.dx);
      const dy = Number(p.dy);
      const parts = [dx ? `${Math.abs(dx)} ${units} ${dx > 0 ? 'right' : 'left'}` : '', dy ? `${Math.abs(dy)} ${units} ${p.units === 'grid' ? (dy > 0 ? 'up' : 'down') : dy > 0 ? 'down' : 'up'}` : ''].filter(Boolean);
      return `move ${target} ${parts.join(' and ') || 'in place'}`;
    }
    case 'follow-path':
      return `move ${target} along its approved path`;
    case 'press':
      return `press ${target}`;
    case 'selected-outline':
      return `outline ${target} as selected`;
    case 'drop-snap':
      return `snap ${target} into place`;
    case 'success-highlight':
      return `briefly highlight ${target} in the success colour`;
    case 'celebration-clip':
      return `play the “${String(p.clip ?? 'celebrate')}” clip on ${target} ${rep}`;
    case 'particle-burst':
      return `show a small particle burst around ${target}`;
    case 'retry-cue':
      return `outline ${target} to show where to look again`;
    case 'guided-return':
      return `show ${target} gliding back to its starting place`;
    case 'scene-cut':
      return 'show the screen immediately';
    case 'scene-fade':
      return 'fade the screen in';
    case 'scene-slide':
      return `slide the screen in from the ${String(p.from ?? 'right')}`;
    case 'character-clip':
      return `play ${target}'s “${String(p.clip ?? 'wave')}” clip ${rep}`;
  }
}

/** Readable rule, e.g. “When Screen 2 · Spot the parallel sides opens → play Swiftee's “wave” clip once.” */
export function describeBinding(config: GameConfig, b: AnimationBinding): string {
  const screen = listScreens(config).find((s) => s.id === b.screenId);
  const screenLabel = screen?.label ?? b.screenId;
  const entityLabel = (id: string) => screen?.entities.find((e) => e.id === id)?.label ?? id;
  // Dependencies are named by what they do, never by their internal id.
  const dep = b.after ? config.motion.bindings.find((x) => x.id === b.after) : undefined;
  const after = b.after ? (dep ? ` (after “${MOTION_PRESETS[dep.presetId].label}” on ${entityLabel(dep.target)})` : ' (after an earlier animation)') : '';
  const delay = b.timing.delayMs ? ` after ${(b.timing.delayMs / 1000).toFixed(1)} s` : '';
  return `${when(b, screenLabel, entityLabel)} → ${effect(b, entityLabel(b.target), entityLabel)}${delay}${after}.`;
}
