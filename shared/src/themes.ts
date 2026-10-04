import type { ThemeId } from './schemas/brief.ts';
import type { Decor, Palette } from './schemas/game.ts';
import { contrastRatio } from './contrast.ts';

/**
 * Game themes chosen by the creator. These are for learners and deliberately
 * independent of the studio's dark interface.
 */

export interface PaletteOption {
  id: string;
  label: string;
  palette: Palette;
}

export interface ThemePreset {
  id: ThemeId;
  label: string;
  description: string;
  decor: Decor;
  mover: 'plane' | 'penguin' | 'rocket' | 'bus' | 'marker';
  fontStyle: 'rounded' | 'clean';
  palettes: PaletteOption[];
}

export const THEME_PRESETS: Record<ThemeId, ThemePreset> = {
  airport: {
    id: 'airport',
    label: 'Airport control',
    description: 'Runways, a control tower and bright safety colors.',
    decor: 'airport',
    mover: 'plane',
    fontStyle: 'rounded',
    palettes: [
      {
        id: 'daylight',
        label: 'Daylight',
        palette: {
          background: '#E8F1FA', backgroundAlt: '#D3E5F5', surface: '#FFFFFF', surfaceText: '#182B3C', text: '#13283A',
          mutedText: '#3F5468', primary: '#1F5FAD', primaryText: '#FFFFFF', accent: '#D9480F', gridLine: '#A3BDD4',
          gridAxis: '#1E3A55', success: '#1B7F45', error: '#B3261E', focus: '#6B3FD1',
        },
      },
      {
        id: 'dusk',
        label: 'Dusk',
        palette: {
          background: '#1B2440', backgroundAlt: '#26315A', surface: '#FFF8EE', surfaceText: '#1B2440', text: '#FFF4E6',
          mutedText: '#E0D2C2', primary: '#FFB547', primaryText: '#2A1A00', accent: '#FF8A65', gridLine: '#4A5683',
          gridAxis: '#FFE2B8', success: '#17703F', error: '#A8231C', focus: '#9BD7FF',
        },
      },
    ],
  },
  ice: {
    id: 'ice',
    label: 'Ice adventure',
    description: 'Glaciers, snow drifts and cool, calm blues.',
    decor: 'ice',
    mover: 'penguin',
    fontStyle: 'rounded',
    palettes: [
      {
        id: 'glacier',
        label: 'Glacier',
        palette: {
          background: '#EAF6FF', backgroundAlt: '#D3ECFB', surface: '#FFFFFF', surfaceText: '#10304A', text: '#0E2A42',
          mutedText: '#3D5A73', primary: '#0B6FB8', primaryText: '#FFFFFF', accent: '#C2410C', gridLine: '#A9CBE3',
          gridAxis: '#24557D', success: '#157A4A', error: '#B3261E', focus: '#7A3FD1',
        },
      },
      {
        id: 'aurora',
        label: 'Aurora night',
        palette: {
          background: '#0E2238', backgroundAlt: '#16324F', surface: '#F4FAFF', surfaceText: '#0E2238', text: '#F2F8FF',
          mutedText: '#B9D2E8', primary: '#6FE3C7', primaryText: '#062A24', accent: '#FFB86B', gridLine: '#33577A',
          gridAxis: '#CFE6FA', success: '#17703F', error: '#A8231C', focus: '#FFD166',
        },
      },
    ],
  },
  space: {
    id: 'space',
    label: 'Space mission',
    description: 'Stars, planets and a mission-control feel.',
    decor: 'space',
    mover: 'rocket',
    fontStyle: 'clean',
    palettes: [
      {
        id: 'nebula',
        label: 'Nebula',
        palette: {
          background: '#0B1026', backgroundAlt: '#151C3D', surface: '#F5F3FF', surfaceText: '#161034', text: '#F4F1FF',
          mutedText: '#C3BCE8', primary: '#8F7CFF', primaryText: '#0B0726', accent: '#5CE1E6', gridLine: '#2D3769',
          gridAxis: '#D7D2FF', success: '#17703F', error: '#A8231C', focus: '#FFD166',
        },
      },
      {
        id: 'orbit',
        label: 'Orbit (light)',
        palette: {
          background: '#EEF0FF', backgroundAlt: '#DCE0FF', surface: '#FFFFFF', surfaceText: '#1A1A40', text: '#16163A',
          mutedText: '#4A4A78', primary: '#4338CA', primaryText: '#FFFFFF', accent: '#0E7C8A', gridLine: '#B5B9E8',
          gridAxis: '#2E2E6B', success: '#157A4A', error: '#B3261E', focus: '#B45309',
        },
      },
    ],
  },
  city: {
    id: 'city',
    label: 'Friendly city',
    description: 'Streets, parks and warm, welcoming colors.',
    decor: 'city',
    mover: 'bus',
    fontStyle: 'rounded',
    palettes: [
      {
        id: 'sunny',
        label: 'Sunny',
        palette: {
          background: '#FFF7E8', backgroundAlt: '#FDEBC8', surface: '#FFFFFF', surfaceText: '#2B2118', text: '#2A1F14',
          mutedText: '#5E4E3C', primary: '#C2410C', primaryText: '#FFFFFF', accent: '#1F7A55', gridLine: '#DDBF8C',
          gridAxis: '#6B4A1F', success: '#1B7F45', error: '#B3261E', focus: '#2563EB',
        },
      },
      {
        id: 'park',
        label: 'Park',
        palette: {
          background: '#EEF8EC', backgroundAlt: '#D9F0D5', surface: '#FFFFFF', surfaceText: '#183018', text: '#15301A',
          mutedText: '#44604A', primary: '#1F7A3A', primaryText: '#FFFFFF', accent: '#B45309', gridLine: '#A3CFA0',
          gridAxis: '#24502C', success: '#1B7F45', error: '#B3261E', focus: '#7C3AED',
        },
      },
    ],
  },
  custom: {
    id: 'custom',
    label: 'Custom reference',
    description: 'A neutral base you style with your own backgrounds, characters and colors.',
    decor: 'none',
    mover: 'marker',
    fontStyle: 'clean',
    palettes: [
      {
        id: 'neutral',
        label: 'Neutral',
        palette: {
          background: '#F5F6F8', backgroundAlt: '#E7EAEE', surface: '#FFFFFF', surfaceText: '#1E2430', text: '#1C2230',
          mutedText: '#4A5363', primary: '#2F5BD3', primaryText: '#FFFFFF', accent: '#C2410C', gridLine: '#BDC4CF',
          gridAxis: '#2F3746', success: '#1B7F45', error: '#B3261E', focus: '#7C3AED',
        },
      },
      {
        id: 'high-contrast',
        label: 'High contrast',
        palette: {
          background: '#FFFFFF', backgroundAlt: '#F0F0F0', surface: '#FFFFFF', surfaceText: '#000000', text: '#000000',
          mutedText: '#333333', primary: '#0040C1', primaryText: '#FFFFFF', accent: '#B00020', gridLine: '#8A8A8A',
          gridAxis: '#000000', success: '#00692E', error: '#B00020', focus: '#6A00FF',
        },
      },
    ],
  },
};

export function findPalette(themeId: ThemeId, paletteId: string): PaletteOption {
  const preset = THEME_PRESETS[themeId];
  return preset.palettes.find((p) => p.id === paletteId) ?? preset.palettes[0]!;
}

export interface PaletteContrastIssue {
  pair: string;
  ratio: number;
  required: number;
}

/** Pairs that carry information in the runtime and the minimum contrast each needs. */
export const PALETTE_CONTRAST_RULES: Array<{ fg: keyof Palette; bg: keyof Palette; min: number; label: string }> = [
  { fg: 'text', bg: 'background', min: 4.5, label: 'Text on background' },
  { fg: 'text', bg: 'backgroundAlt', min: 4.5, label: 'Text on alternate background' },
  { fg: 'mutedText', bg: 'background', min: 4.5, label: 'Muted text on background' },
  { fg: 'surfaceText', bg: 'surface', min: 4.5, label: 'Panel text' },
  { fg: 'primaryText', bg: 'primary', min: 4.5, label: 'Button text' },
  { fg: 'gridAxis', bg: 'background', min: 3, label: 'Grid axes' },
  { fg: 'accent', bg: 'background', min: 3, label: 'Targets and markers' },
  { fg: 'success', bg: 'surface', min: 3, label: 'Success indicator' },
  { fg: 'error', bg: 'surface', min: 3, label: 'Error indicator' },
  { fg: 'focus', bg: 'background', min: 3, label: 'Keyboard focus ring' },
  { fg: 'primary', bg: 'background', min: 3, label: 'Button boundary' },
];

export function checkPaletteContrast(p: Palette): PaletteContrastIssue[] {
  const out: PaletteContrastIssue[] = [];
  for (const rule of PALETTE_CONTRAST_RULES) {
    const ratio = contrastRatio(p[rule.fg], p[rule.bg]);
    if (ratio < rule.min) out.push({ pair: rule.label, ratio: Math.round(ratio * 100) / 100, required: rule.min });
  }
  return out;
}
