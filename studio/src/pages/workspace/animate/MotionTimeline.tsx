import type { GameConfig } from '@shared/schemas/game.ts';
import { TRIGGER_LABELS, type AnimationBinding, type MotionTrigger } from '@shared/schemas/motion.ts';
import type { ScreenInfo } from '@shared/motion/entities.ts';
import { MOTION_PRESETS } from '@shared/motion/presets.ts';

/** Start and end (ms after the trigger) of each binding, following delays and “after” chains. */
export function schedule(config: GameConfig, bindings: AnimationBinding[]): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  const byId = new Map(bindings.map((b) => [b.id, b]));
  const calm = config.motion.pacing === 'calm';
  const visit = (b: AnimationBinding, depth: number): { start: number; end: number } => {
    const hit = out.get(b.id);
    if (hit) return hit;
    const dep = b.after ? byId.get(b.after) : undefined;
    const base = dep && depth < 8 ? visit(dep, depth + 1).end : 0;
    const start = base + b.timing.delayMs;
    const dur = Math.round(b.timing.durationMs * (calm && MOTION_PRESETS[b.presetId].purpose !== 'feedback' ? 1.3 : 1)) * b.timing.repeat;
    const r = { start, end: start + dur };
    out.set(b.id, r);
    return r;
  };
  for (const b of bindings) visit(b, 0);
  return out;
}

/** A compact view of when each animation on the screen runs, per trigger. Read-only. */
export function MotionTimeline({ config, screen, selectedId, onSelect }: { config: GameConfig; screen: ScreenInfo; selectedId: string | null; onSelect: (id: string) => void }) {
  const bindings = config.motion.bindings.filter((b) => b.screenId === screen.id && b.enabled);
  const groups = new Map<MotionTrigger, AnimationBinding[]>();
  for (const b of bindings) groups.set(b.trigger.event, [...(groups.get(b.trigger.event) ?? []), b]);
  if (bindings.length === 0) return <p className="subtle small timeline-empty">No animations on this screen yet.</p>;
  return (
    <div className="timeline" role="region" aria-label="Timeline">
      {[...groups.entries()].map(([trigger, list]) => {
        const sched = schedule(config, list);
        const total = Math.max(1000, ...[...sched.values()].map((v) => v.end));
        return (
          <div key={trigger} className="timeline-group">
            <p className="timeline-trigger small">
              When {TRIGGER_LABELS[trigger]} <span className="subtle">· {(total / 1000).toFixed(1)} s</span>
            </p>
            {list.map((b) => {
              const s = sched.get(b.id)!;
              return (
                <button key={b.id} type="button" className={`timeline-row${selectedId === b.id ? ' is-selected' : ''}`} onClick={() => onSelect(b.id)} aria-label={`${MOTION_PRESETS[b.presetId].label} on ${screen.entities.find((e) => e.id === b.target)?.label ?? b.target}, from ${s.start} to ${s.end} milliseconds`}>
                  <span className="timeline-label truncate">
                    {MOTION_PRESETS[b.presetId].label} · {screen.entities.find((e) => e.id === b.target)?.label ?? b.target}
                  </span>
                  <span className="timeline-track">
                    <span className={`timeline-bar purpose-${b.purpose}`} style={{ left: `${(s.start / total) * 100}%`, width: `${Math.max(1.5, ((s.end - s.start) / total) * 100)}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
