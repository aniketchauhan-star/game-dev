import { useState } from 'react';

/**
 * Tiny interactive previews on the mechanic cards. They are real (if small)
 * interactions: click a grid point, place a card, or swap two items. Keyboard
 * users can operate them too; motion is minimal.
 */

export function MiniCoordinate() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const target = { x: 2, y: 1 };
  const toS = (x: number, y: number) => ({ sx: 60 + x * 16, sy: 40 - y * 16 });
  const done = pos.x === target.x && pos.y === target.y;
  const t = toS(target.x, target.y);
  const m = toS(pos.x, pos.y);
  return (
    <div className="mini" role="group" aria-label="Try it: move the dot to (2, 1)">
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <rect x="4" y="2" width="112" height="76" rx="8" className="mini-bg" />
        {[-3, -2, -1, 0, 1, 2, 3].map((x) => (
          <line key={`gx${x}`} x1={60 + x * 16} y1="8" x2={60 + x * 16} y2="72" className={x === 0 ? 'mini-axis' : 'mini-grid'} />
        ))}
        {[-2, -1, 0, 1, 2].map((y) => (
          <line key={`gy${y}`} x1="12" y1={40 - y * 16} x2="108" y2={40 - y * 16} className={y === 0 ? 'mini-axis' : 'mini-grid'} />
        ))}
        <circle cx={t.sx} cy={t.sy} r="7" className="mini-target" />
        <circle cx={m.sx} cy={m.sy} r="5" className={done ? 'mini-dot is-done' : 'mini-dot'} style={{ transition: 'cx 160ms, cy 160ms' }} />
      </svg>
      <div className="mini-pad">
        {(
          [
            ['←', -1, 0, 'left'],
            ['↑', 0, 1, 'up'],
            ['↓', 0, -1, 'down'],
            ['→', 1, 0, 'right'],
          ] as const
        ).map(([g, dx, dy, name]) => (
          <button
            key={name}
            type="button"
            aria-label={`Move ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              setPos((p) => ({ x: Math.max(-3, Math.min(3, p.x + dx)), y: Math.max(-2, Math.min(2, p.y + dy)) }));
            }}
          >
            {g}
          </button>
        ))}
      </div>
      <p className="mini-caption" aria-live="polite">
        {done ? 'Reached (2, 1)' : `At (${pos.x}, ${pos.y}) → reach (2, 1)`}
      </p>
    </div>
  );
}

export function MiniMatch() {
  const [placed, setPlaced] = useState<Record<string, string | null>>({ a: null, b: null });
  const [sel, setSel] = useState<string | null>(null);
  const items = [
    { id: 'a', label: '(2, 3)', target: 'I' },
    { id: 'b', label: '(−1, 2)', target: 'II' },
  ];
  const done = items.every((i) => placed[i.id] === i.target);
  return (
    <div className="mini" role="group" aria-label="Try it: match each point to its quadrant">
      <div className="mini-bays">
        {['I', 'II'].map((t) => (
          <button
            key={t}
            type="button"
            className="mini-bay"
            aria-label={`Quadrant ${t}${sel ? ' — place selected card here' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!sel) return;
              setPlaced((p) => ({ ...p, [sel]: t }));
              setSel(null);
            }}
          >
            <span>Q{t}</span>
            {items
              .filter((i) => placed[i.id] === t)
              .map((i) => (
                <span key={i.id} className={`mini-card${i.target === t ? ' is-ok' : ''}`}>
                  {i.label}
                </span>
              ))}
          </button>
        ))}
      </div>
      <div className="mini-tray">
        {items
          .filter((i) => !placed[i.id])
          .map((i) => (
            <button
              key={i.id}
              type="button"
              className={`mini-card${sel === i.id ? ' is-sel' : ''}`}
              aria-pressed={sel === i.id}
              onClick={(e) => {
                e.stopPropagation();
                setSel(sel === i.id ? null : i.id);
              }}
            >
              {i.label}
            </button>
          ))}
      </div>
      <p className="mini-caption" aria-live="polite">
        {done ? 'Both matched' : 'Select a card, then a quadrant'}
      </p>
    </div>
  );
}

export function MiniSort() {
  const [order, setOrder] = useState([3, 1, 2]);
  const done = order.join() === '1,2,3';
  const labels: Record<number, string> = { 1: 'Origin', 2: 'Move x', 3: 'Move y' };
  return (
    <div className="mini" role="group" aria-label="Try it: put the plotting steps in order">
      <ol className="mini-sort">
        {order.map((n, i) => (
          <li key={n}>
            <span>{labels[n]}</span>
            {i < order.length - 1 && (
              <button
                type="button"
                aria-label={`Swap ${labels[n]} with ${labels[order[i + 1]!]}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOrder((o) => {
                    const c = o.slice();
                    [c[i], c[i + 1]] = [c[i + 1]!, c[i]!];
                    return c;
                  });
                }}
              >
                ⇄
              </button>
            )}
          </li>
        ))}
      </ol>
      <p className="mini-caption" aria-live="polite">
        {done ? 'In order' : 'Swap neighbours until the steps are in order'}
      </p>
    </div>
  );
}
