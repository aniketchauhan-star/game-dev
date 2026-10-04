import type { MechanicId } from './schemas/common.ts';
import type { SceneType } from './schemas/interaction.ts';

/**
 * Explicit registry of what the trusted runtime can build. Anything not listed
 * here as buildable is rejected with a message — never silently replaced.
 */

export interface MechanicInfo {
  id: MechanicId;
  label: string;
  summary: string;
  buildable: boolean;
  /** Scene types a game built around this mechanic may use. */
  sceneTypes: SceneType[];
  example: string;
}

export const MECHANICS: Record<MechanicId, MechanicInfo> = {
  'coordinate-navigation': {
    id: 'coordinate-navigation',
    label: 'Coordinate navigation',
    summary: 'Learners move a character or vehicle to positions on a coordinate grid.',
    buildable: true,
    sceneTypes: ['info', 'coordinate-navigation', 'drag-match', 'sequence-sort'],
    example: 'Guide the aircraft to runway (3, −2).',
  },
  'drag-match': {
    id: 'drag-match',
    label: 'Drag-and-match',
    summary: 'Learners pair or group items with the right targets — by dragging or by selecting.',
    buildable: true,
    sceneTypes: ['info', 'drag-match', 'sequence-sort', 'coordinate-navigation'],
    example: 'Match each point to its quadrant.',
  },
  'sequence-sort': {
    id: 'sequence-sort',
    label: 'Sequence sorting',
    summary: 'Learners put steps, events or values in the correct order.',
    buildable: true,
    sceneTypes: ['info', 'sequence-sort', 'drag-match', 'coordinate-navigation'],
    example: 'Order the landing steps from first to last.',
  },
  custom: {
    id: 'custom',
    label: 'Describe another idea',
    summary: 'Any other interaction. Produces an editable blueprint and a developer handoff — Blueprint only until a compatible builder exists.',
    buildable: false,
    sceneTypes: ['custom', 'info'],
    example: 'A timed card-flip memory game.',
  },
};

export interface SceneTypeInfo {
  type: SceneType;
  label: string;
  buildable: boolean;
}

export const SCENE_TYPES: Record<SceneType, SceneTypeInfo> = {
  info: { type: 'info', label: 'Concept card', buildable: true },
  'coordinate-navigation': { type: 'coordinate-navigation', label: 'Coordinate navigation', buildable: true },
  'drag-match': { type: 'drag-match', label: 'Drag-and-match', buildable: true },
  'sequence-sort': { type: 'sequence-sort', label: 'Sequence sorting', buildable: true },
  custom: { type: 'custom', label: 'Custom (blueprint only)', buildable: false },
};

export function isBuildableSceneType(type: string): type is Exclude<SceneType, 'custom'> {
  return Object.prototype.hasOwnProperty.call(SCENE_TYPES, type) && SCENE_TYPES[type as SceneType].buildable;
}

export const UNSUPPORTED_MESSAGE =
  'This mechanic supports a blueprint but not an in-app build yet. Export a Developer handoff to build it in code.';
