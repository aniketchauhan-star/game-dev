/**
 * Validates the studio design tokens' foreground/background pairs (WCAG 2.x).
 * Text needs 4.5:1 (3:1 for large display text); UI boundaries and focus need 3:1.
 */
import { contrastRatio } from '../shared/src/contrast.ts';

export const STUDIO_TOKENS = {
  bgApp: '#080D18',
  bgSidebar: '#0C1322',
  bgPanel: '#111C2D',
  bgPanelRaised: '#17243A',
  borderSubtle: '#263650',
  borderStrong: '#6A80A6',
  textPrimary: '#F3F7FF',
  textSecondary: '#B4C2D8',
  textTertiary: '#93A4BF',
  accentCyan: '#68E0F5',
  accentPeriwinkle: '#8FB2FF',
  accentViolet: '#A398FF',
  success: '#7AE3BA',
  warning: '#FFD087',
  danger: '#FF94A5',
  onAccent: '#06121C',
};

const T = STUDIO_TOKENS;
const surfaces = { 'bg-app': T.bgApp, 'bg-sidebar': T.bgSidebar, 'bg-panel': T.bgPanel, 'bg-panel-raised': T.bgPanelRaised };
const checks: Array<{ label: string; fg: string; bg: string; min: number }> = [];
for (const [name, bg] of Object.entries(surfaces)) {
  checks.push({ label: `text-primary on ${name}`, fg: T.textPrimary, bg, min: 4.5 });
  checks.push({ label: `text-secondary on ${name}`, fg: T.textSecondary, bg, min: 4.5 });
  checks.push({ label: `text-tertiary on ${name}`, fg: T.textTertiary, bg, min: 4.5 });
  checks.push({ label: `accent-cyan text on ${name}`, fg: T.accentCyan, bg, min: 4.5 });
  checks.push({ label: `accent-violet text on ${name}`, fg: T.accentViolet, bg, min: 4.5 });
  checks.push({ label: `success text on ${name}`, fg: T.success, bg, min: 4.5 });
  checks.push({ label: `warning text on ${name}`, fg: T.warning, bg, min: 4.5 });
  checks.push({ label: `danger text on ${name}`, fg: T.danger, bg, min: 4.5 });
  checks.push({ label: `border-strong (control boundary) on ${name}`, fg: T.borderStrong, bg, min: 3 });
  checks.push({ label: `focus ring (cyan) on ${name}`, fg: T.accentCyan, bg, min: 3 });
}
checks.push({ label: 'on-accent text on cyan (gradient start)', fg: T.onAccent, bg: T.accentCyan, min: 4.5 });
checks.push({ label: 'on-accent text on periwinkle (gradient end)', fg: T.onAccent, bg: T.accentPeriwinkle, min: 4.5 });
checks.push({ label: 'on-accent text on violet', fg: T.onAccent, bg: T.accentViolet, min: 4.5 });

let failed = 0;
for (const c of checks) {
  const r = contrastRatio(c.fg, c.bg);
  const ok = r >= c.min;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1  (needs ${c.min})  ${c.label}`);
}
console.log(failed ? `\n${failed} combination(s) fail.` : '\nAll checked combinations pass.');
if (failed && process.argv.includes('--strict')) process.exit(1);
