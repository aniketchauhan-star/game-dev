import './env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gameConfigSchema } from '@shared/schemas/game.ts';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import type { GameVersion } from '@shared/schemas/records.ts';
import { buildPptx } from '../../../fixtures/scripts/pptx-builder.ts';
import { FAKE_KEY, isSafeRelativeEntry, SAMPLE_NOTES_SENTENCES, sampleDeck, setApiKey, sha256, STUB_RUNTIME_FILES, Studio } from './helpers.ts';

const SAMPLE_FOLDER = 'air-traffic-control-coordinate-mission';
const CONVERSATION_MARKER = 'Quixotic-Marmalade-4417';

/** Every entry is relative, safe and inside the single top-level folder. */
function expectSafeArchive(entries: Map<string, Buffer>, folder: string): string[] {
  const names = [...entries.keys()];
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(isSafeRelativeEntry(name), name).toBe(true);
    expect(name.startsWith(`${folder}/`), name).toBe(true);
  }
  return names.map((n) => n.slice(folder.length + 1));
}

/** Names of entries whose bytes contain any of the needles (text and binary files alike). */
function entriesContaining(entries: Map<string, Buffer>, needles: readonly string[]): string[] {
  const hits: string[] = [];
  for (const [name, data] of entries) {
    const text = data.toString('utf8');
    for (const n of needles) if (text.includes(n)) hits.push(`${name} ⊃ “${n}”`);
  }
  return hits;
}

const FORBIDDEN_IN_ANY_EXPORT = [...SAMPLE_NOTES_SENTENCES, FAKE_KEY, 'FAKEKEY', CONVERSATION_MARKER];

describe('exports', () => {
  let s: Studio;
  let sample: ProjectDetail;
  let v1: GameVersion;

  beforeAll(async () => {
    s = await Studio.start();
    sample = await s.createSample();
    v1 = (await s.get(`/api/versions/${sample.currentVersionId}`)).json().version as GameVersion;
    // The creator has a conversation in this project; it must never be exported.
    const chat = await s.post(`/api/projects/${sample.id}/chat`, { text: `Please add a zebra named ${CONVERSATION_MARKER}`, mode: 'refine', scope: { kind: 'project', sceneId: null, slideId: null }, area: 'build' });
    expect(chat.statusCode, chat.body).toBe(202);
    await s.runJobs();
    // Exports are created while a key is configured on the server; it must never be exported either.
    setApiKey(FAKE_KEY);
  });

  afterAll(async () => {
    setApiKey(null);
    await s.close();
  });

  it('preflight reports the checks that actually ran and writes nothing', async () => {
    const res = await s.post(`/api/projects/${sample.id}/exports/preflight`, { kind: 'playable' });
    expect(res.statusCode, res.body).toBe(200);
    const { preflight, files } = res.json();
    expect(preflight).toMatchObject({ kind: 'playable', label: 'Playable game', playable: true, versionId: v1.id, versionNumber: 1, blueprintRevisionNumber: 1, blocking: false });
    const checks = Object.fromEntries((preflight.checks as Array<{ id: string; status: string }>).map((c) => [c.id, c.status]));
    expect(checks).toMatchObject({ schema: 'pass', attainable: 'pass', assets: 'pass', demo: 'info', unsupported: 'pass', paths: 'pass', secrets: 'pass' });
    expect(preflight.testsRun).toEqual(expect.arrayContaining(['GameConfig schema validation', 'Export path safety validation', 'Secret scan of exported text files']));
    expect((files as string[]).every((f) => f.startsWith(`${SAMPLE_FOLDER}/`))).toBe(true);
    expect(files).toContain(`${SAMPLE_FOLDER}/index.html`);
    expect((await s.get(`/api/projects/${sample.id}/exports`)).json().exports).toEqual([]);
    expect(fs.readdirSync(path.join(s.dataDir, 'exports'))).toEqual([]);
  });

  it('playable: relative entries with index.html, game.config.js, runtime and assets — and no notes, deck, .env, conversation or key', async () => {
    const { record, entries } = await s.exportZip(sample.id, { kind: 'playable' });
    expect(record).toMatchObject({ kind: 'playable', label: 'Playable game', fileName: `${SAMPLE_FOLDER}-v1.zip` });
    const files = expectSafeArchive(entries, SAMPLE_FOLDER);

    for (const required of ['index.html', 'game.config.js', 'README.txt', 'PREFLIGHT.md', ...STUB_RUNTIME_FILES]) {
      expect(files, required).toContain(required);
    }
    expect(Object.keys(v1.config.assets).length).toBeGreaterThan(0);
    for (const asset of Object.values(v1.config.assets)) {
      const served = (await s.get(`/api/assets/${asset.id}/file?variant=display`)).rawPayload;
      expect(sha256(entries.get(`${SAMPLE_FOLDER}/${asset.file}`)!), asset.file).toBe(sha256(served));
    }
    const forbidden = files.filter((f) => /\.(pptx?|pptm|key|map|sqlite)$|(^|\/)\.env|^source-material\/|^game\.config\.json$|^assets\/originals\//i.test(f));
    expect(forbidden).toEqual([]);
    expect(entriesContaining(entries, FORBIDDEN_IN_ANY_EXPORT)).toEqual([]);

    const js = entries.get(`${SAMPLE_FOLDER}/game.config.js`)!.toString('utf8');
    const match = js.match(/window\.NEXUS_GAME_CONFIG = (\{.*\});\n$/s);
    expect(match).not.toBeNull();
    const config = JSON.parse(match![1]!);
    expect(gameConfigSchema.safeParse(config).success).toBe(true);
    expect(config).toEqual(v1.config);

    const html = entries.get(`${SAMPLE_FOLDER}/index.html`)!.toString('utf8');
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*connect-src 'none'/);
    expect(html).toContain('<script src="game.config.js"></script>');
    expect(html).toContain('<script src="runtime/runtime.js"></script>');
    expect(html).not.toMatch(/(src|href)="\//);
  });

  it('source package: editable config, build scripts and runtime sources — still no notes, deck, conversation or key', async () => {
    const { record, entries } = await s.exportZip(sample.id, { kind: 'source' });
    expect(record).toMatchObject({ kind: 'source', label: 'Source package', fileName: `${SAMPLE_FOLDER}-source-v1.zip` });
    const folder = `${SAMPLE_FOLDER}-source`;
    const files = expectSafeArchive(entries, folder);
    for (const required of ['game.config.json', 'build.mjs', 'serve.mjs', 'package.json', 'README.md', 'asset-map.json', 'index.html', 'runtime/runtime.js', 'runtime-src/README.md', 'runtime-src/runtime/main.ts', 'runtime-src/shared/schemas/game.ts', 'PREFLIGHT.md']) {
      expect(files, required).toContain(required);
    }
    expect(files.some((f) => f.startsWith('assets/originals/'))).toBe(true);
    expect(files.filter((f) => /\.pptx?$|^source-material\/|(^|\/)\.env/i.test(f))).toEqual([]);
    expect(entriesContaining(entries, FORBIDDEN_IN_ANY_EXPORT)).toEqual([]);
    expect(gameConfigSchema.safeParse(JSON.parse(entries.get(`${folder}/game.config.json`)!.toString('utf8'))).success).toBe(true);
  });

  it('Claude Code handoff: README, CLAUDE, GAME_DESIGN, TASKS, ASSET_GUIDE, game.config.json and source-map.json — without speaker notes', async () => {
    const { record, entries } = await s.exportZip(sample.id, { kind: 'handoff', nextChanges: 'Add a countdown timer to the final scene.' });
    expect(record).toMatchObject({ kind: 'handoff', label: 'Claude Code handoff', fileName: `${SAMPLE_FOLDER}-claude-handoff-v1.zip` });
    const folder = `${SAMPLE_FOLDER}-claude-handoff`;
    const files = expectSafeArchive(entries, folder);
    for (const required of ['README.md', 'CLAUDE.md', 'GAME_DESIGN.md', 'TASKS.md', 'ASSET_GUIDE.md', 'game.config.json', 'source-map.json', 'blueprint.json', 'build.mjs', 'PREFLIGHT.md']) {
      expect(files, required).toContain(required);
    }
    expect(files.filter((f) => /\.pptx?$|^source-material\//i.test(f))).toEqual([]);
    expect(entriesContaining(entries, FORBIDDEN_IN_ANY_EXPORT)).toEqual([]);

    const sourceMap = JSON.parse(entries.get(`${folder}/source-map.json`)!.toString('utf8'));
    expect(sourceMap.note).toBe('Scene ↔ slide mapping. Speaker notes are never included here.');
    expect(sourceMap.slides).toHaveLength(9);
    expect(sourceMap.scenes.map((x: { id: string }) => x.id)).toEqual(v1.config.scenes.map((x) => x.id));
    expect(entries.get(`${folder}/TASKS.md`)!.toString('utf8')).toContain('Add a countdown timer to the final scene.');
    expect(entries.get(`${folder}/CLAUDE.md`)!.toString('utf8')).toContain('`game.config.json`');
  });

  it('includeSourceMaterial adds source-material/ to source and handoff exports, never to the playable game', async () => {
    for (const kind of ['handoff', 'source'] as const) {
      const { record, entries } = await s.exportZip(sample.id, { kind, includeSourceMaterial: true });
      expect(record).toMatchObject({ includeSourceMaterial: true });
      expect(record.preflight.checks.find((c) => c.id === 'source-material')).toMatchObject({ status: 'info' });
      const folder = kind === 'handoff' ? `${SAMPLE_FOLDER}-claude-handoff` : `${SAMPLE_FOLDER}-source`;
      const files = expectSafeArchive(entries, folder);
      const material = files.filter((f) => f.startsWith('source-material/'));
      const deck = material.find((f) => f.endsWith('.pptx'));
      expect(deck, kind).toBeDefined();
      expect(sha256(entries.get(`${folder}/${deck}`)!)).toBe(sha256(sampleDeck()));
      expect(material).toContain('source-material/extracted-slides.json');
      // The creator asked for the source material, so the extracted notes are there — and only there.
      const withNotes = entriesContaining(entries, [SAMPLE_NOTES_SENTENCES[0]]).map((h) => h.split(' ⊃ ')[0]!);
      expect(withNotes.length).toBeGreaterThan(0);
      expect(withNotes.every((n) => n.startsWith(`${folder}/source-material/`)), withNotes.join(', ')).toBe(true);
      expect(entriesContaining(entries, [FAKE_KEY, CONVERSATION_MARKER])).toEqual([]);
    }

    const playable = await s.exportZip(sample.id, { kind: 'playable', includeSourceMaterial: true });
    const files = expectSafeArchive(playable.entries, SAMPLE_FOLDER);
    expect(files.filter((f) => f.startsWith('source-material/') || /\.pptx$/i.test(f))).toEqual([]);
    expect(entriesContaining(playable.entries, FORBIDDEN_IN_ANY_EXPORT)).toEqual([]);
  });

  it('lists exports and serves them only as attachments', async () => {
    const list = (await s.get(`/api/projects/${sample.id}/exports`)).json().exports as Array<{ id: string; fileName: string }>;
    expect(list.length).toBeGreaterThanOrEqual(6);
    const dl = await s.get(`/api/exports/${list[0]!.id}/download`);
    expect(String(dl.headers['content-disposition'])).toMatch(new RegExp(`^attachment; filename="${list[0]!.fileName.replace(/[.]/g, '\\.')}"`));
    expect((await s.get('/api/exports/exp_doesnotexist/download')).statusCode).toBe(404);
  });

  it('the secret scan stops an export whose content contains an API key', async () => {
    const other = await s.createSample();
    const edit = await s.post(`/api/projects/${other.id}/edits`, {
      baseVersionId: other.currentVersionId,
      ops: [{ op: 'set-project-field', field: 'screens.completion.message', value: 'Support: sk-ant-api03-ABCDEFGHIJKLMNOPQRST' }],
      scope: { kind: 'project', sceneId: null },
      summary: 'Completion message',
    });
    expect(edit.statusCode, edit.body).toBe(200);

    const pre = (await s.post(`/api/projects/${other.id}/exports/preflight`, { kind: 'playable' })).json().preflight;
    expect(pre.blocking).toBe(true);
    expect(pre.checks.find((c: { id: string }) => c.id === 'secrets')).toMatchObject({ status: 'fail' });
    expect(pre.checks.find((c: { id: string }) => c.id === 'secrets').detail).toContain('game.config.js');

    const res = await s.post(`/api/projects/${other.id}/exports`, { kind: 'playable' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('preflight_failed');
    expect((await s.get(`/api/projects/${other.id}/exports`)).json().exports).toEqual([]);
    expect(fs.readdirSync(path.join(s.dataDir, 'exports')).filter((f) => f.startsWith(`${other.id}-`))).toEqual([]);
  });

  describe('blueprint-only project (custom mechanic)', () => {
    const IDEA = 'A timed card-flip memory game where learners pair each cell part with its job.';
    const NOTE = 'Private teacher note: students confuse mitochondria and ribosomes.';
    let projectId: string;

    beforeAll(async () => {
      projectId = (await s.createProject('Memory Match')).id;
      const deck = buildPptx({
        slides: [
          { partNumber: 1, layout: 'title', title: 'Cell parts memory match', subtitle: 'Biology, Grade 8' },
          { partNumber: 2, layout: 'content', title: 'Parts of a cell', bullets: ['The nucleus holds DNA.', 'Mitochondria release energy.', 'Ribosomes build proteins.'], notes: [NOTE] },
        ],
      });
      await s.importDeck(projectId, deck, 'cell-memory.pptx');
      await s.saveBrief(projectId, { title: 'Cell Memory Match', mechanic: 'custom', customIdea: IDEA });
      const approved = await s.approvedManualBlueprint(projectId, (bp) => {
        bp.scenes[1]!.interaction = { type: 'custom', description: 'Flip two cards at a time; a pair stays face up when the part matches its job.' };
      });
      expect(approved.blueprint).toMatchObject({ coreMechanic: 'custom', customMechanicDescription: IDEA, title: 'Cell Memory Match' });
    });

    it('cannot be exported as a playable game or source package', async () => {
      for (const kind of ['playable', 'source']) {
        const res = await s.post(`/api/projects/${projectId}/exports`, { kind });
        expect(res.statusCode, kind).toBe(409);
        expect(res.json().error).toMatchObject({ code: 'not_playable', hint: 'This mechanic is blueprint only — export the Developer handoff instead.' });
      }
    });

    it('exports a developer handoff with the design but no build.mjs or game.config.json, and says it is not playable', async () => {
      const { record, entries } = await s.exportZip(projectId, { kind: 'handoff', nextChanges: 'Use a 60-second timer.' });
      expect(record).toMatchObject({ label: 'Developer handoff', fileName: 'cell-memory-match-developer-handoff.zip' });
      expect(record.preflight.playable).toBe(false);
      expect(record.preflight.unsupportedScenes).toHaveLength(1);
      const folder = 'cell-memory-match-developer-handoff';
      const files = expectSafeArchive(entries, folder);
      for (const required of ['README.md', 'CLAUDE.md', 'GAME_DESIGN.md', 'TASKS.md', 'ASSET_GUIDE.md', 'blueprint.json', 'source-map.json', 'asset-map.json', 'PREFLIGHT.md', 'runtime-src/README.md']) {
        expect(files, required).toContain(required);
      }
      for (const absent of ['build.mjs', 'serve.mjs', 'game.config.json', 'game.config.js', 'index.html', 'package.json']) {
        expect(files, absent).not.toContain(absent);
      }
      expect(files.filter((f) => f.startsWith('runtime/'))).toEqual([]);

      const readme = entries.get(`${folder}/README.md`)!.toString('utf8');
      expect(readme).toMatch(/^# Cell Memory Match — developer handoff/);
      expect(readme).toContain('**not** a playable game');
      expect(entries.get(`${folder}/CLAUDE.md`)!.toString('utf8')).toContain('there is no playable `game.config.json` and nothing to build yet');
      const tasks = entries.get(`${folder}/TASKS.md`)!.toString('utf8');
      expect(tasks).toContain(`## Build the custom mechanic\n\n${IDEA}`);
      expect(tasks).toContain('Use a 60-second timer.');
      expect(entries.get(`${folder}/GAME_DESIGN.md`)!.toString('utf8')).toContain('blueprint only — no in-app builder yet');
      const blueprint = JSON.parse(entries.get(`${folder}/blueprint.json`)!.toString('utf8'));
      expect(blueprint.scenes[1].interaction.type).toBe('custom');
      expect(entriesContaining(entries, [NOTE, FAKE_KEY, 'FAKEKEY'])).toEqual([]);
    });
  });
});

describe('exports when the game runtime has not been built', () => {
  let bare: Studio;

  beforeAll(async () => {
    bare = await Studio.start({ dist: 'empty' });
  });

  afterAll(async () => {
    await bare.close();
  });

  it('a playable export explains that the runtime must be built first', async () => {
    const p = await bare.createSample();
    const res = await bare.post(`/api/projects/${p.id}/exports`, { kind: 'playable' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: 'runtime_missing', message: 'The game runtime has not been built.', hint: 'Run `npm run build:runtime` and try again.' });
    expect(fs.readdirSync(path.join(bare.dataDir, 'exports'))).toEqual([]);
  });

  it('a blueprint-only developer handoff does not need the built runtime (it ships none)', async () => {
    const p = await bare.createProject('Unbuilt handoff');
    const deck = buildPptx({ slides: [{ partNumber: 1, layout: 'content', title: 'Fractions on a beat', bullets: ['Half notes are 1/2 of a whole note.'] }] });
    await bare.importDeck(p.id, deck, 'rhythm.pptx');
    await bare.saveBrief(p.id, { title: 'Fraction Rhythm', mechanic: 'custom', customIdea: 'A rhythm game where learners tap fractions of a beat.' });
    await bare.approvedManualBlueprint(p.id, (bp) => {
      bp.scenes[0]!.interaction = { type: 'custom', description: 'Tap on each half and quarter beat as the bar scrolls past.' };
    });
    const res = await bare.post(`/api/projects/${p.id}/exports`, { kind: 'handoff' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().export).toMatchObject({ label: 'Developer handoff', fileName: 'fraction-rhythm-developer-handoff.zip' });
  });
});
