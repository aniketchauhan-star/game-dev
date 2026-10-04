import type { GameConfig, GameScene } from '@shared/schemas/game.ts';
import type { Sound } from './audio.ts';
import type { TriggerEvent } from './motion/director.ts';

export type ProgressEvent = 'title-shown' | 'scene-started' | 'scene-completed' | 'attempt' | 'hint' | 'game-completed' | 'restarted';

/** What a scene implementation receives from the game shell. */
export interface SceneHost {
  config: GameConfig;
  scene: GameScene;
  index: number;
  total: number;
  sound: Sound;
  reducedMotion: boolean;
  assetUrl(id: string | null | undefined): string | null;
  /** Report progress to the parent studio (preview only) — never stored by the runtime. */
  report(event: ProgressEvent, detail?: { correct?: boolean; attempt?: number; hintLevel?: number }): void;
  /** Called once the scene's rule is satisfied. */
  complete(): void;
  /** Tell the motion system what just happened. Motion never changes game state. */
  emit(event: TriggerEvent): void;
  /** Drag input takes priority over decorative motion on the object being handled. */
  yieldToInput(entity: string): void;
}

export interface SceneController {
  el: HTMLElement;
  /** Called after the element is attached (measurements are valid). */
  mount(): void;
  /** Keyboard shortcuts handled by the scene; return true when consumed. */
  onKey?(e: KeyboardEvent): boolean;
  destroy(): void;
}
