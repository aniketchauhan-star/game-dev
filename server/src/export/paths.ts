/** Validation for every path written into an export archive. */
export function safeZipPath(p: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 240) throw new Error(`Unsafe export path (length): ${p}`);
  if (p.includes('\0') || p.includes('\\')) throw new Error(`Unsafe export path (characters): ${p}`);
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new Error(`Unsafe export path (absolute): ${p}`);
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`Unsafe export path (segments): ${p}`);
  if (!segments.every((s) => /^[A-Za-z0-9][A-Za-z0-9._ ()+-]*$/.test(s))) throw new Error(`Unsafe export path (name): ${p}`);
  return p;
}

/** Folder-safe slug for archive and folder names. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return slug || 'game';
}
