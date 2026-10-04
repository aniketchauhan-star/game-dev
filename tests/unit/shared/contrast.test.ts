import { describe, expect, it } from 'vitest';
import { blend, contrastRatio, parseHex, relativeLuminance } from '@shared/contrast.ts';
import { paletteSchema } from '@shared/schemas/game.ts';
import { themeId } from '@shared/schemas/brief.ts';
import { checkPaletteContrast, findPalette, PALETTE_CONTRAST_RULES, THEME_PRESETS } from '@shared/themes.ts';

describe('contrast math (WCAG 2.x)', () => {
  it('black on white is 21:1 and identical colors are 1:1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 10);
    expect(contrastRatio('#3F5468', '#3F5468')).toBeCloseTo(1, 10);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#1F5FAD', '#E8F1FA')).toBe(contrastRatio('#E8F1FA', '#1F5FAD'));
  });

  it('matches well-known reference values', () => {
    // #767676 is the lightest grey that passes AA on white; #777777 just fails.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#FF0000', '#FFFFFF')).toBeCloseTo(4.0, 2);
    expect(contrastRatio('#0000FF', '#FFFFFF')).toBeCloseTo(8.59, 2);
  });

  it('computes relative luminance', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 10);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 10);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 10);
  });

  it('parses hex colors with or without # in any case, and rejects anything else', () => {
    expect(parseHex('#1f5fad')).toEqual([0x1f, 0x5f, 0xad]);
    expect(parseHex('1F5FAD')).toEqual([0x1f, 0x5f, 0xad]);
    expect(parseHex(' #FFFFFF ')).toEqual([255, 255, 255]);
    for (const bad of ['#FFF', 'red', '#GGGGGG', '#1234567', '']) expect(() => parseHex(bad), bad).toThrow(/Invalid hex color/);
  });

  it('blends translucent colors over a background', () => {
    expect(blend('#000000', 0.5, '#FFFFFF')).toBe('#808080');
    expect(blend('#1F5FAD', 1, '#FFFFFF')).toBe('#1f5fad');
    expect(blend('#1F5FAD', 0, '#E8F1FA')).toBe('#e8f1fa');
  });
});

const PALETTES = Object.values(THEME_PRESETS).flatMap((preset) => preset.palettes.map((p) => ({ theme: preset.id, ...p })));
const TEXT_PAIRS = PALETTE_CONTRAST_RULES.filter((r) => r.fg.toLowerCase().endsWith('text'));

describe('game themes', () => {
  it('cover every theme id with at least one palette', () => {
    expect(Object.keys(THEME_PRESETS).sort()).toEqual([...themeId.options].sort());
    for (const [id, preset] of Object.entries(THEME_PRESETS)) {
      expect(preset.id).toBe(id);
      expect(preset.palettes.length).toBeGreaterThan(0);
      expect(new Set(preset.palettes.map((p) => p.id)).size).toBe(preset.palettes.length);
    }
  });

  it.each(PALETTES)('$theme/$id is a valid palette', ({ palette }) => {
    expect(paletteSchema.safeParse(palette).success).toBe(true);
  });

  it('defines text pairs at the WCAG AA text minimum of 4.5:1', () => {
    expect(TEXT_PAIRS.map((r) => `${r.fg}/${r.bg}`).sort()).toEqual(['mutedText/background', 'primaryText/primary', 'surfaceText/surface', 'text/background', 'text/backgroundAlt']);
    for (const rule of TEXT_PAIRS) expect(rule.min, rule.label).toBeGreaterThanOrEqual(4.5);
    for (const rule of PALETTE_CONTRAST_RULES) expect(rule.min, rule.label).toBeGreaterThanOrEqual(3);
  });

  describe.each(PALETTES)('$theme/$id', ({ palette }) => {
    it.each(PALETTE_CONTRAST_RULES)('$label ($fg on $bg) meets $min:1', (rule) => {
      expect(contrastRatio(palette[rule.fg], palette[rule.bg])).toBeGreaterThanOrEqual(rule.min);
    });

    it('checkPaletteContrast reports no issues', () => {
      expect(checkPaletteContrast(palette)).toEqual([]);
    });
  });

  it('checkPaletteContrast reports failing pairs with rounded ratios', () => {
    const base = THEME_PRESETS.airport.palettes[0]!.palette;
    const issues = checkPaletteContrast({ ...base, text: '#FFFFFF', primaryText: base.primary });
    expect(issues).toContainEqual({ pair: 'Button text', ratio: 1, required: 4.5 });
    expect(issues.map((i) => i.pair)).toEqual(expect.arrayContaining(['Text on background', 'Text on alternate background', 'Button text']));
    for (const i of issues) expect(Math.round(i.ratio * 100) / 100).toBe(i.ratio);
  });

  it('findPalette falls back to the first palette of the theme for unknown ids', () => {
    expect(findPalette('space', 'orbit').id).toBe('orbit');
    expect(findPalette('space', 'no-such-palette').id).toBe(THEME_PRESETS.space.palettes[0]!.id);
  });
});
