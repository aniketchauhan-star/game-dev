import { describe, expect, it } from 'vitest';
import { frameToStage, parseFigmaUrl } from '@shared/schemas/design.ts';

describe('parseFigmaUrl', () => {
  it('accepts Design file and frame links and converts node ids', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/TrapQuestDemo8x2026/Trapezium-Quest?node-id=10-1&t=abc')).toEqual({ ok: true, fileKey: 'TrapQuestDemo8x2026', nodeId: '10:1', branchKey: null, kind: 'design', apiKey: 'TrapQuestDemo8x2026' });
    expect(parseFigmaUrl('https://figma.com/file/TrapQuestDemo8x2026/x')).toMatchObject({ ok: true, nodeId: null, kind: 'file' });
    // A branch link reads the branch, never the main file.
    expect(parseFigmaUrl('https://www.figma.com/design/TrapQuestDemo8x2026/branch/BranchKey12345/x?node-id=1-2')).toMatchObject({ ok: true, branchKey: 'BranchKey12345', apiKey: 'BranchKey12345', nodeId: '1:2' });
  });

  it('rejects other hosts, credentials in links, unsupported editors and malformed ids', () => {
    const reasons = [
      'http://www.figma.com/design/TrapQuestDemo8x2026/x',
      'https://figma.com.evil.example/design/TrapQuestDemo8x2026/x',
      'https://user:pass@www.figma.com/design/TrapQuestDemo8x2026/x',
      'https://www.figma.com:8443/design/TrapQuestDemo8x2026/x',
      'https://www.figma.com/board/TrapQuestDemo8x2026/x',
      'https://www.figma.com/slides/TrapQuestDemo8x2026/x',
      'https://www.figma.com/make/TrapQuestDemo8x2026/x',
      'https://www.figma.com/design/short/x',
      'https://www.figma.com/design/TrapQuestDemo8x2026/x?node-id=I10:1;20:3',
      'javascript:alert(1)',
      'not a link',
    ].map((u) => {
      const r = parseFigmaUrl(u);
      return r.ok ? 'accepted' : r.reason;
    });
    expect(reasons).toEqual([
      'Figma links start with https://.',
      'Only figma.com links are supported.',
      'That is not a figma.com link.',
      'That is not a figma.com link.',
      'FigJam boards are not supported.',
      'Figma Slides decks are not supported.',
      'Figma Make files are not supported.',
      'The link does not contain a valid file key.',
      'The node-id in the link is not a frame id I can use.',
      'Figma links start with https://.',
      'That is not a web link.',
    ]);
  });
});

describe('frameToStage', () => {
  it('never stretches: letterboxes with contain and crops with cover', () => {
    expect(frameToStage({ w: 1920, h: 1080 }, 'contain')).toEqual({ scale: 1, dx: 0, dy: 0 });
    const tall = frameToStage({ w: 1440, h: 1024 }, 'contain');
    expect(tall.scale).toBeCloseTo(1080 / 1024);
    expect(tall.dy).toBeCloseTo(0);
    expect(tall.dx).toBeCloseTo((1920 - 1440 * (1080 / 1024)) / 2);
    const cover = frameToStage({ w: 1440, h: 1024 }, 'cover');
    expect(cover.scale).toBeCloseTo(1920 / 1440);
    expect(cover.dx).toBeCloseTo(0);
    expect(cover.dy).toBeLessThan(0);
  });
});
