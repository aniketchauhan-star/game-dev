/** NEXUS orbital mark: a core with two tilted orbits. Decorative unless given a title. */
export function OrbitalMark({ size = 32, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <linearGradient id="nx-mark-core" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#68E0F5" />
          <stop offset="1" stopColor="#8FB2FF" />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="16" rx="13" ry="5.6" fill="none" stroke="#68E0F5" strokeOpacity="0.85" strokeWidth="1.6" transform="rotate(-28 16 16)" />
      <ellipse cx="16" cy="16" rx="13" ry="5.6" fill="none" stroke="#A398FF" strokeOpacity="0.75" strokeWidth="1.6" transform="rotate(32 16 16)" />
      <circle cx="16" cy="16" r="4.6" fill="url(#nx-mark-core)" />
      <circle cx="27.1" cy="9.9" r="1.9" fill="#F3F7FF" />
    </svg>
  );
}
