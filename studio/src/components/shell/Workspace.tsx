import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PanelLeft, PanelRight, Sparkles } from 'lucide-react';
import { IconButton } from '../ui/controls.tsx';

/**
 * Three-panel workspace: context inspector (left), dominant canvas (center),
 * Claude panel (right). Side panels resize within bounds (pointer or arrow
 * keys) and collapse; below 1280px the Claude panel becomes a drawer, and below
 * 1024px the workspace switches to task tabs.
 */

const LEFT = { min: 208, max: 380, def: 256 };
const RIGHT = { min: 288, max: 460, def: 336 };

function readWidth(key: string, def: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : def;
  } catch {
    return def;
  }
}

function writeWidth(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(Math.round(v)));
  } catch {
    // storage unavailable — width just resets next visit
  }
}

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

function Resizer({ side, value, onChange, bounds }: { side: 'left' | 'right'; value: number; onChange: (v: number) => void; bounds: { min: number; max: number } }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize inspector panel' : 'Resize Claude panel'}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: value };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        const next = start.current.w + (side === 'left' ? dx : -dx);
        onChange(Math.min(bounds.max, Math.max(bounds.min, next)));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 12;
        const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
        const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
        if (e.key === grow) onChange(Math.min(bounds.max, value + step));
        else if (e.key === shrink) onChange(Math.max(bounds.min, value - step));
        else return;
        e.preventDefault();
      }}
    />
  );
}

export interface WorkspaceProps {
  leftLabel: string;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  rightLabel?: string;
}

export function Workspace({ leftLabel, left, center, right, rightLabel = 'Claude' }: WorkspaceProps) {
  const compact = useMedia('(max-width: 1279px)');
  const tabbed = useMedia('(max-width: 1023px)');
  const [leftW, setLeftW] = useState(() => readWidth('nx-left-w', LEFT.def));
  const [rightW, setRightW] = useState(() => readWidth('nx-right-w', RIGHT.def));
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState<'left' | 'center' | 'right'>('center');
  const setLeft = useCallback((v: number) => {
    setLeftW(v);
    writeWidth('nx-left-w', v);
  }, []);
  const setRight = useCallback((v: number) => {
    setRightW(v);
    writeWidth('nx-right-w', v);
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  if (tabbed) {
    return (
      <div className="workspace-tabbed">
        <div className="task-tabs" role="tablist" aria-label="Workspace">
          {(
            [
              ['left', leftLabel],
              ['center', 'Workspace'],
              ['right', rightLabel],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="task-pane" role="tabpanel">
          {tab === 'left' ? <aside className="panel-left">{left}</aside> : tab === 'right' ? <aside className="panel-right">{right}</aside> : <section className="canvas">{center}</section>}
        </div>
      </div>
    );
  }

  const cols = [leftOpen ? `${leftW}px` : '0px', leftOpen ? '5px' : '0px', 'minmax(0, 1fr)', !compact && rightOpen ? '5px' : '0px', !compact && rightOpen ? `${rightW}px` : '0px'].join(' ');
  return (
    <div className="workspace" style={{ gridTemplateColumns: cols }}>
      <aside className="panel-left" aria-label={leftLabel} hidden={!leftOpen}>
        {left}
      </aside>
      {leftOpen ? <Resizer side="left" value={leftW} onChange={setLeft} bounds={LEFT} /> : <div />}
      <section className="canvas" aria-label="Workspace">
        <div className="canvas-toggles">
          <IconButton label={leftOpen ? `Hide ${leftLabel.toLowerCase()}` : `Show ${leftLabel.toLowerCase()}`} size="sm" pressed={leftOpen} onClick={() => setLeftOpen((o) => !o)}>
            <PanelLeft size={17} aria-hidden="true" />
          </IconButton>
          {compact ? (
            <IconButton label="Open Claude panel" size="sm" onClick={() => setDrawer(true)}>
              <Sparkles size={17} aria-hidden="true" />
            </IconButton>
          ) : (
            <IconButton label={rightOpen ? 'Hide Claude panel' : 'Show Claude panel'} size="sm" pressed={rightOpen} onClick={() => setRightOpen((o) => !o)}>
              <PanelRight size={17} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        {center}
      </section>
      {!compact && rightOpen ? <Resizer side="right" value={rightW} onChange={setRight} bounds={RIGHT} /> : <div />}
      {!compact && (
        <aside className="panel-right" aria-label={rightLabel} hidden={!rightOpen}>
          {right}
        </aside>
      )}
      {compact && drawer && (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
          <aside className="panel-right drawer-right" aria-label={rightLabel} role="dialog" aria-modal="true">
            {right}
          </aside>
        </>
      )}
    </div>
  );
}
