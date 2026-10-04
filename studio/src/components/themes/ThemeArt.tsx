import type { ThemeId } from '@shared/schemas/brief.ts';
import { findPalette } from '@shared/themes.ts';

/** Small 16:9 theme preview rendered in the game's own palette (not the studio's). */
export function ThemeArt({ themeId, paletteId, label, showGrid = true }: { themeId: ThemeId; paletteId: string; label?: string; showGrid?: boolean }) {
  const p = findPalette(themeId, paletteId).palette;
  const decor = (() => {
    switch (themeId) {
      case 'airport':
        return (
          <g>
            <ellipse cx="40" cy="22" rx="16" ry="6" fill="#FFFFFF" opacity="0.85" />
            <ellipse cx="128" cy="16" rx="20" ry="7" fill="#FFFFFF" opacity="0.8" />
            <rect x="0" y="70" width="160" height="20" fill={p.backgroundAlt} />
            <rect x="0" y="76" width="160" height="7" fill="#6B7680" opacity="0.6" />
            {Array.from({ length: 8 }, (_, i) => (
              <rect key={i} x={6 + i * 20} y="79" width="9" height="1.6" fill="#FFFFFF" opacity="0.85" />
            ))}
            <path d="M140 76l1.5-20h5l1.5 20z" fill="#C8CED6" />
            <rect x="137" y="52" width="14" height="6" rx="1.5" fill={p.primary} />
          </g>
        );
      case 'ice':
        return (
          <g>
            <path d="M0 68C26 58 44 62 66 68S110 58 134 64 152 70 160 66V90H0z" fill="#FFFFFF" opacity="0.92" />
            <path d="M0 76C30 70 60 78 96 74S140 70 160 77V90H0z" fill={p.backgroundAlt} />
            <path d="M118 70l12-28 12 28z" fill="#CFE8F7" stroke="#FFFFFF" strokeWidth="1.2" />
            {Array.from({ length: 12 }, (_, i) => (
              <circle key={i} cx={(i * 37) % 160} cy={(i * 17) % 50} r="1" fill="#FFFFFF" opacity="0.8" />
            ))}
          </g>
        );
      case 'space':
        return (
          <g>
            {Array.from({ length: 30 }, (_, i) => (
              <circle key={i} cx={(i * 53) % 160} cy={(i * 29) % 90} r={0.5 + (i % 3) * 0.4} fill="#FFFFFF" opacity={0.4 + (i % 4) * 0.15} />
            ))}
            <circle cx="132" cy="22" r="11" fill={p.accent} opacity="0.65" />
            <ellipse cx="132" cy="22" rx="18" ry="3.4" fill="none" stroke={p.primary} strokeWidth="1.4" opacity="0.7" />
            <circle cx="14" cy="90" r="30" fill={p.backgroundAlt} />
          </g>
        );
      case 'city':
        return (
          <g>
            {[26, 38, 30, 46, 34, 42, 28, 36].map((h, i) => (
              <rect key={i} x={i * 20 + 2} y={78 - h} width="16" height={h} rx="1.5" fill={i % 2 ? p.backgroundAlt : '#FFFFFF'} opacity="0.9" />
            ))}
            <rect x="0" y="78" width="160" height="12" fill="#8C96A3" opacity="0.55" />
            {Array.from({ length: 6 }, (_, i) => (
              <circle key={i} cx={12 + i * 28} cy="77" r="4.5" fill="#3E9B5C" opacity="0.8" />
            ))}
          </g>
        );
      default:
        return <rect x="0" y="70" width="160" height="20" fill={p.backgroundAlt} />;
    }
  })();
  return (
    <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="theme-art">
      <rect width="160" height="90" fill={p.background} />
      {decor}
      {showGrid && (
        <g>
          <rect x="52" y="20" width="56" height="44" rx="4" fill={p.surface} opacity="0.94" />
          {[60, 68, 76, 84, 92, 100].map((x) => (
            <line key={`x${x}`} x1={x} y1="24" x2={x} y2="60" stroke={p.gridLine} strokeWidth="0.6" />
          ))}
          {[28, 36, 44, 52].map((y) => (
            <line key={`y${y}`} x1="56" y1={y} x2="104" y2={y} stroke={p.gridLine} strokeWidth="0.6" />
          ))}
          <line x1="56" y1="44" x2="104" y2="44" stroke={p.gridAxis} strokeWidth="1.2" />
          <line x1="80" y1="24" x2="80" y2="60" stroke={p.gridAxis} strokeWidth="1.2" />
          <circle cx="92" cy="36" r="3" fill={p.accent} />
          <rect x="62" y="66" width="36" height="9" rx="3" fill={p.primary} />
        </g>
      )}
    </svg>
  );
}
