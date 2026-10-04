import type { ReactElement } from 'react';
import type { SceneInteraction } from '@shared/schemas/interaction.ts';

/** Lightweight scene preview drawn from the interaction data (not a screenshot of the game). */
export function SceneThumb({ interaction, title }: { interaction: SceneInteraction; title?: string }) {
  const W = 160;
  const H = 90;
  let body: ReactElement;
  switch (interaction.type) {
    case 'coordinate-navigation': {
      const g = interaction.grid;
      const unit = Math.min((W - 30) / (g.xMax - g.xMin), (H - 20) / (g.yMax - g.yMin));
      const ox = 15 + (0 - g.xMin) * unit + ((W - 30) - unit * (g.xMax - g.xMin)) / 2;
      const oy = 10 + g.yMax * unit;
      const toS = (x: number, y: number) => ({ x: ox + x * unit, y: oy - y * unit });
      const lines: ReactElement[] = [];
      for (let x = g.xMin; x <= g.xMax; x += g.step) lines.push(<line key={`x${x}`} x1={toS(x, 0).x} y1={toS(0, g.yMax).y} x2={toS(x, 0).x} y2={toS(0, g.yMin).y} className={x === 0 ? 'th-axis' : 'th-grid'} />);
      for (let y = g.yMin; y <= g.yMax; y += g.step) lines.push(<line key={`y${y}`} x1={toS(g.xMin, 0).x} y1={toS(0, y).y} x2={toS(g.xMax, 0).x} y2={toS(0, y).y} className={y === 0 ? 'th-axis' : 'th-grid'} />);
      const r = interaction.rule;
      const targets = r.kind === 'point-equals' ? [r.target] : r.kind === 'point-in-set' ? r.targets : [];
      const start = toS(interaction.start.x, interaction.start.y);
      body = (
        <g>
          {r.kind === 'in-quadrant' && (
            <rect
              x={r.quadrant === 1 || r.quadrant === 4 ? toS(0, 0).x : toS(g.xMin, 0).x}
              y={r.quadrant === 1 || r.quadrant === 2 ? toS(0, g.yMax).y : toS(0, 0).y}
              width={Math.abs((r.quadrant === 1 || r.quadrant === 4 ? g.xMax : g.xMin) * unit)}
              height={Math.abs((r.quadrant === 1 || r.quadrant === 2 ? g.yMax : g.yMin) * unit)}
              className="th-zone"
            />
          )}
          {lines}
          {targets.map((t, i) => (
            <circle key={i} cx={toS(t.x, t.y).x} cy={toS(t.x, t.y).y} r={4.5} className="th-target" />
          ))}
          <circle cx={start.x} cy={start.y} r={3.5} className="th-mover" />
        </g>
      );
      break;
    }
    case 'drag-match': {
      const n = interaction.targets.length;
      const w = (W - 16 - (n - 1) * 4) / n;
      body = (
        <g>
          {interaction.targets.map((t, i) => (
            <rect key={t.id} x={8 + i * (w + 4)} y={10} width={w} height={44} rx={4} className="th-bay" />
          ))}
          {interaction.items.slice(0, 8).map((it, i) => (
            <rect key={it.id} x={8 + (i % 8) * 18} y={64} width={15} height={12} rx={3} className="th-card" />
          ))}
        </g>
      );
      break;
    }
    case 'sequence-sort': {
      const n = interaction.items.length;
      const w = (W - 16 - (n - 1) * 4) / n;
      body = (
        <g>
          <line x1={10} y1={18} x2={W - 10} y2={18} className="th-axis" markerEnd="" />
          {interaction.items.map((it, i) => (
            <g key={it.id}>
              <rect x={8 + i * (w + 4)} y={30} width={w} height={40} rx={4} className="th-card" />
              <text x={8 + i * (w + 4) + w / 2} y={55} textAnchor="middle" className="th-num">
                {i + 1}
              </text>
            </g>
          ))}
        </g>
      );
      break;
    }
    case 'info':
      body = (
        <g>
          <rect x={14} y={12} width={W - 28} height={H - 24} rx={6} className="th-bay" />
          {interaction.points.map((_, i) => (
            <rect key={i} x={24} y={24 + i * 12} width={W - 70 - (i % 2) * 20} height={5} rx={2.5} className="th-line" />
          ))}
        </g>
      );
      break;
    default:
      body = (
        <g>
          <rect x={10} y={10} width={W - 20} height={H - 20} rx={6} className="th-custom" />
          <text x={W / 2} y={H / 2 + 4} textAnchor="middle" className="th-label">
            Blueprint only
          </text>
        </g>
      );
  }
  return (
    <svg className="scene-thumb" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title ? `Preview of ${title}` : 'Scene preview'}>
      <rect width={W} height={H} rx={8} className="th-bg" />
      {body}
    </svg>
  );
}
