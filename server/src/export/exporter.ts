import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { checkInteraction } from '@shared/attainability.ts';
import { EXPORT_LABELS, type ExportKind, type ExportRecord, type Preflight, type PreflightCheck } from '@shared/schemas/exports.ts';
import { gameConfigSchema, type GameConfig } from '@shared/schemas/game.ts';
import { effectiveSlideText } from '@shared/schemas/source.ts';
import { isBuildableSceneType } from '@shared/registry.ts';
import { validateBindings } from '@shared/motion/validate.ts';
import type { App } from '../app.ts';
import { REPO_ROOT } from '../config.ts';
import { computeUsage, getAssetRow, listAssetRows, toAsset } from '../db/assets.ts';
import { activeBranchId, getBranch } from '../db/branches.ts';
import { framesById, listDesignImports } from '../db/design.ts';
import { currentGradeProfile, listGradePlans } from '../db/grade.ts';
import { currentScreenMap } from '../db/screens.ts';
import { approvedBlueprint, getBlueprintRevision, latestBlueprint } from '../db/learning.ts';
import { insertExport, newExportId } from '../db/misc.ts';
import { getProjectRow, projectBrief } from '../db/projects.ts';
import { listDocuments, listSlides, getDocumentRow } from '../db/sources.ts';
import { currentVersion, getVersion } from '../db/versions.ts';
import { badRequest, HttpError } from '../errors.ts';
import { getApiKey, getFigmaToken } from '../secrets.ts';
import { assetFile } from '../services/assets.ts';
import { assetGuideMd, BUILD_MJS, claudeMd, developerHandoffReadme, gameDesignMd, playableReadme, preflightMarkdown, SERVE_MJS, sourceReadme, tasksMd } from './docs.ts';
import { animationGuideMd, animationManifest, designMap, gradeProfileMd } from './designDocs.ts';
import { safeZipPath, slugify } from './paths.ts';

/**
 * Builds the three exports. Every archive path is validated, the archive is
 * scanned for secrets before it is kept, and the preflight report lists only
 * checks that actually ran.
 */

type Entry = { path: string; data: Buffer | string } | { path: string; file: string };

export function runtimeDistDir(app: App): string {
  return path.join(app.config.distDir, 'runtime');
}

export function exportIndexHtml(title: string): string {
  const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="generator" content="NEXUS Play Studio">
<title>${esc}</title>
<link rel="stylesheet" href="runtime/runtime.css">
</head>
<body>
<main id="nexus-game" class="nx-root" aria-label="${esc}"></main>
<noscript>This game needs JavaScript to run.</noscript>
<script src="game.config.js"></script>
<script src="runtime/runtime.js"></script>
</body>
</html>
`;
}

function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function writeZip(file: string, entries: Entry[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const seen = new Set<string>();
    for (const e of entries) {
      const p = safeZipPath(e.path);
      if (seen.has(p)) throw new Error(`Duplicate export path ${p}`);
      seen.add(p);
      if ('file' in e) zip.addFile(e.file, p, { mtime: new Date(0) });
      else zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8'), p, { mtime: new Date(0) });
    }
    zip.end();
    const out = fs.createWriteStream(file);
    zip.outputStream.pipe(out);
    out.on('close', () => resolve(fs.statSync(file).size));
    out.on('error', reject);
  });
}

/** Look for Anthropic keys and Figma tokens in everything we are about to ship. */
function scanForSecrets(entries: Entry[]): string[] {
  const keys = [getApiKey(), getFigmaToken()].filter((k): k is string => Boolean(k) && k!.length >= 8);
  const hits: string[] = [];
  for (const e of entries) {
    const text = 'file' in e ? (/\.(js|json|md|txt|html|css|mjs|ts)$/i.test(e.path) ? fs.readFileSync(e.file, 'utf8') : '') : Buffer.isBuffer(e.data) ? '' : e.data;
    if (!text) continue;
    if (
      keys.some((k) => text.includes(k)) ||
      /sk-ant-[A-Za-z0-9_-]{12,}/.test(text) ||
      /figd_[A-Za-z0-9_-]{8,}/.test(text) ||
      /(ANTHROPIC_API_KEY|FIGMA_ACCESS_TOKEN)\s*=\s*\S+/.test(text) ||
      /X-Figma-Token\s*:\s*\S+/i.test(text)
    )
      hits.push(e.path);
  }
  return hits;
}

/** Keep only the assets the game actually uses (unused imports and design references are left out). */
function pruneAssets(config: GameConfig): { config: GameConfig; dropped: number } {
  const used = computeUsage(config, null, []);
  const keep = Object.fromEntries(Object.entries(config.assets).filter(([id]) => used.has(id)));
  const dropped = Object.keys(config.assets).length - Object.keys(keep).length;
  if (!dropped) return { config, dropped: 0 };
  const next = gameConfigSchema.safeParse({ ...config, assets: keep });
  return next.success ? { config: next.data, dropped } : { config, dropped: 0 };
}

interface ExportInput {
  kind: ExportKind;
  versionId: string | null;
  includeSourceMaterial: boolean;
  nextChanges: string;
}

export interface PreparedExport {
  preflight: Preflight;
  entries: Entry[];
  folder: string;
  config: GameConfig | null;
  label: string;
  branchId: string;
}

/** Assemble entries + preflight. Used both for “check only” and for the real export. */
export function prepareExport(app: App, projectId: string, input: ExportInput): PreparedExport {
  const project = getProjectRow(app.db, projectId);
  const brief = projectBrief(project);
  const slides = listSlides(app.db, projectId);
  const assets = listAssetRows(app.db, projectId).map((r) => toAsset(r));
  const version = input.versionId ? getVersion(app.db, input.versionId) : currentVersion(app.db, projectId);
  if (version && version.projectId !== projectId) throw badRequest('That version belongs to another project.');
  const branchId = version?.branchId ?? activeBranchId(app.db, projectId);
  const blueprintRev = version?.blueprintRevisionId ? getBlueprintRevision(app.db, version.blueprintRevisionId) : (approvedBlueprint(app.db, projectId) ?? latestBlueprint(app.db, projectId));
  const blueprint = blueprintRev?.blueprint ?? null;
  const unsupported = (blueprint?.scenes ?? []).filter((s) => !isBuildableSceneType(s.interaction.type)).map((s) => `${s.title}: ${s.interaction.type === 'custom' ? s.interaction.description.slice(0, 120) : s.interaction.type}`);
  const playable = Boolean(version);
  if (!playable && input.kind !== 'handoff') {
    throw new HttpError(409, 'not_playable', 'There is no playable version to export yet.', unsupported.length ? 'This mechanic is blueprint only — export the Developer handoff instead.' : 'Approve a blueprint and build the game first.');
  }
  if (!playable && !blueprint) throw new HttpError(409, 'nothing_to_export', 'There is no blueprint or game to export yet.');
  const label = input.kind === 'handoff' && !playable ? 'Developer handoff' : EXPORT_LABELS[input.kind];

  const checks: PreflightCheck[] = [];
  const testsRun: string[] = [];
  const missingAssets: string[] = [];
  const unresolved: string[] = [];
  let config: GameConfig | null = null;

  if (version) {
    const parsed = gameConfigSchema.safeParse(version.config);
    testsRun.push('GameConfig schema validation');
    if (parsed.success) {
      const pruned = pruneAssets(parsed.data);
      config = pruned.config;
      checks.push({ id: 'schema', label: 'Game configuration schema', status: 'pass', detail: `v${version.number} matches GameConfig schema version ${config.schemaVersion}.` });
      if (pruned.dropped) checks.push({ id: 'unused-assets', label: 'Only assets in use', status: 'info', detail: `${pruned.dropped} asset(s) attached to the version but not used by any screen or animation were left out.` });
    } else {
      checks.push({ id: 'schema', label: 'Game configuration schema', status: 'fail', detail: parsed.error.issues[0]?.message ?? 'invalid' });
    }
    if (config) {
      testsRun.push('Scene attainability checks (deterministic rule engine)');
      const problems = config.scenes.flatMap((s, i) => checkInteraction(s.interaction, { seed: config!.settings.seed, sceneId: s.id }).filter((x) => x.severity === 'error').map((x) => `Scene ${i + 1}: ${x.message}`));
      checks.push({ id: 'attainable', label: 'Every scene can be completed', status: problems.length ? 'fail' : 'pass', detail: problems.length ? problems.join('; ') : `${config.scenes.length} scenes checked.` });
      testsRun.push('Asset file presence');
      for (const a of Object.values(config.assets)) {
        try {
          const row = getAssetRow(app.db, a.id);
          if (!fs.existsSync(assetFile(app, row, 'display').file)) missingAssets.push(`${a.alt || a.id} (${a.file})`);
        } catch {
          missingAssets.push(`${a.alt || a.id} (${a.file})`);
        }
      }
      checks.push({ id: 'assets', label: 'Asset files present', status: missingAssets.length ? 'fail' : 'pass', detail: missingAssets.length ? `${missingAssets.length} missing` : `${Object.keys(config.assets).length} asset file(s) found.` });
      const usedSlides = new Set(config.scenes.flatMap((s) => s.sourceSlideIds));
      for (const s of slides) {
        if (!usedSlides.has(s.id)) continue;
        if (s.reviewStatus !== 'verified') unresolved.push(`Slide ${s.slideNumber} “${effectiveSlideText(s).title || 'untitled'}” is ${s.reviewStatus === 'missing_visual' ? 'missing a visual reference' : 'not yet verified by the creator'}.`);
        for (const w of s.extract.warnings.filter((w) => w.severity === 'warning')) unresolved.push(`Slide ${s.slideNumber}: ${w.message}`);
      }
      checks.push({ id: 'source', label: 'Source warnings resolved', status: unresolved.length ? 'warn' : 'pass', detail: unresolved.length ? `${unresolved.length} item(s) to review` : 'All slides used by the game are verified.' });
      if (config.meta.demo) checks.push({ id: 'demo', label: 'Content origin', status: 'info', detail: 'Contains demo sample content (prepared fixtures, not generated by Claude).' });
      testsRun.push('Animation checks (targets, triggers, budgets, dependencies)');
      const motionIssues = validateBindings(config);
      const motionErrors = motionIssues.filter((i) => i.severity === 'error');
      const motionWarnings = motionIssues.filter((i) => i.severity === 'warning');
      checks.push({
        id: 'motion',
        label: 'Animations validated',
        status: motionErrors.length ? 'fail' : motionWarnings.length ? 'warn' : 'pass',
        detail: motionErrors.length ? motionErrors.slice(0, 3).map((i) => i.message).join('; ') : motionWarnings.length ? `${motionWarnings.length} warning(s): ${motionWarnings[0]!.message}` : `${config.motion.bindings.length} animation(s) on ${new Set(config.motion.bindings.map((b) => b.screenId)).size} screen(s) pass.`,
      });
      testsRun.push('Offline check: no web addresses in the game configuration');
      const remote = JSON.stringify(config).match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
      checks.push({ id: 'offline', label: 'Runs offline', status: remote.length ? 'warn' : 'pass', detail: remote.length ? `The configuration mentions ${remote.length} web address(es), e.g. ${remote[0]!.slice(0, 80)} — the game never loads them (network access is blocked), check they are meant as text.` : 'All files are local; the page blocks network requests (connect-src none).' });
      if (config.meta.gradeLabel) checks.push({ id: 'grade', label: 'Grade version', status: 'info', detail: `${config.meta.gradeLabel}${config.meta.gradeProfileRevision ? ` (grade profile revision ${config.meta.gradeProfileRevision})` : ''}.` });
    }
  }
  if (blueprintRev?.stale) checks.push({ id: 'stale', label: 'Blueprint up to date with source', status: 'warn', detail: blueprintRev.staleReason ?? 'Source changed after this blueprint.' });
  checks.push({ id: 'unsupported', label: 'Supported mechanics', status: unsupported.length ? (playable ? 'warn' : 'info') : 'pass', detail: unsupported.length ? `${unsupported.length} blueprint-only scene(s)` : 'All scenes use supported mechanics.' });

  // ── assemble entries ──
  const title = config?.title ?? blueprint?.title ?? project.name;
  const slug = slugify(title);
  const folder = input.kind === 'playable' ? slug : input.kind === 'source' ? `${slug}-source` : `${slug}-${playable ? 'claude-handoff' : 'developer-handoff'}`;
  const runtimeDir = runtimeDistDir(app);
  const runtimeFiles = listFiles(runtimeDir).filter((f) => !f.endsWith('.map') && f !== 'index.html');
  // Only exports that contain a playable game need the built runtime.
  if (config && runtimeFiles.length === 0) throw new HttpError(500, 'runtime_missing', 'The game runtime has not been built.', 'Run `npm run build:runtime` and try again.');
  const entries: Entry[] = [];
  const add = (p: string, data: Buffer | string) => entries.push({ path: `${folder}/${p}`, data });
  const addFile = (p: string, file: string) => entries.push({ path: `${folder}/${p}`, file });
  // A blueprint-only handoff has no game to run, so it carries the runtime source only (below).
  if (config) for (const f of runtimeFiles) addFile(`runtime/${f}`, path.join(runtimeDir, f));
  if (config) {
    for (const a of Object.values(config.assets)) {
      try {
        const row = getAssetRow(app.db, a.id);
        const f = assetFile(app, row, 'display').file;
        if (fs.existsSync(f)) addFile(a.file, f);
      } catch {
        // reported as missing above
      }
    }
  }

  if (input.kind === 'playable') {
    add('index.html', exportIndexHtml(title));
    add('game.config.js', `/* ${title} — generated by NEXUS Play Studio (version ${version!.number}). Edit game.config.json in the source package. */\nwindow.NEXUS_GAME_CONFIG = ${JSON.stringify(config)};\n`);
    add('README.txt', playableReadme(title, version!.number));
  } else {
    if (config) {
      add('index.html', exportIndexHtml(title));
      add('game.config.json', `${JSON.stringify(config, null, 2)}\n`);
      add('build.mjs', BUILD_MJS);
      add('serve.mjs', SERVE_MJS);
      add('package.json', `${JSON.stringify({ name: slug, private: true, type: 'module', scripts: { build: 'node build.mjs', serve: 'node serve.mjs' } }, null, 2)}\n`);
      add('README.md', sourceReadme(title, version?.number ?? null));
    } else {
      add('README.md', developerHandoffReadme(title, blueprintRev?.number ?? null));
    }
    const assetMap = Object.values(config?.assets ?? {}).map((a) => {
      const meta = assets.find((x) => x.id === a.id);
      return { id: a.id, file: a.file, role: meta?.role ?? 'unknown', originalName: meta?.originalName ?? null, source: meta?.source ?? null, width: a.width, height: a.height, transparency: meta?.hasAlpha ?? null, placement: a.placement, sprite: a.sprite };
    });
    add('asset-map.json', `${JSON.stringify({ assets: assetMap }, null, 2)}\n`);
    for (const a of assetMap) {
      try {
        const row = getAssetRow(app.db, a.id);
        const orig = assetFile(app, row, 'original').file;
        if (fs.existsSync(orig)) addFile(`assets/originals/${a.id}-${path.basename(row.original_file)}`, orig);
      } catch {
        // missing original — already reported
      }
    }
    // Runtime and shared rule-engine sources for developers.
    for (const f of listFiles(path.join(REPO_ROOT, 'runtime', 'src'))) addFile(`runtime-src/runtime/${f}`, path.join(REPO_ROOT, 'runtime', 'src', f));
    for (const f of listFiles(path.join(REPO_ROOT, 'shared', 'src'))) addFile(`runtime-src/shared/${f}`, path.join(REPO_ROOT, 'shared', 'src', f));
    add(
      'runtime-src/README.md',
      `# Runtime source\n\n\`runtime/\` is the NEXUS game runtime (TypeScript, no framework). \`shared/\` holds the schemas, coordinate math and the allowlisted rule engine it uses.\n${config ? 'The prebuilt bundle is in `../runtime/`. ' : ''}To rebuild, bundle \`runtime/main.ts\` as an IIFE with Vite or esbuild (alias \`@shared\` → \`./shared\`) and the dependency \`zod\`.\n`,
    );
  }

  if (input.kind === 'handoff') {
    const sourceMap = {
      note: 'Scene ↔ slide mapping. Speaker notes are never included here.',
      slides: slides.map((s) => ({ id: s.id, slideNumber: s.slideNumber, title: effectiveSlideText(s).title, included: s.included, hidden: s.hidden, reviewStatus: s.reviewStatus })),
      scenes: (config?.scenes ?? blueprint?.scenes ?? []).map((s) => ({ id: s.id, title: s.title, sourceSlideIds: s.sourceSlideIds, addedPractice: s.addedPractice })),
    };
    add('source-map.json', `${JSON.stringify(sourceMap, null, 2)}\n`);
    add('CLAUDE.md', claudeMd({ title, playable }));
    if (blueprint) {
      add('GAME_DESIGN.md', gameDesignMd({ blueprint, brief, slides, config, blueprintNumber: blueprintRev?.number ?? null }));
      add('blueprint.json', `${JSON.stringify(blueprint, null, 2)}\n`);
    }
    add('ASSET_GUIDE.md', assetGuideMd({ assets, blueprint, config }));
    // Grade version, Source-to-Screen map and motion (approved data only; no Figma documents, annotations, prompts or credentials).
    const branch = getBranch(app.db, branchId);
    add('GRADE_PROFILE.md', gradeProfileMd({ branchName: branch.name, profile: currentGradeProfile(app.db, branchId), plans: listGradePlans(app.db, branchId), config }));
    const map = currentScreenMap(app.db, branchId);
    const frameIds = (map?.mapping.screens ?? []).flatMap((x) => x.frames.map((l) => l.frameId));
    add('design-map.json', `${JSON.stringify(designMap({ map, frames: framesById(app.db, frameIds), imports: new Map(listDesignImports(app.db, projectId).map((d) => [d.id, d])) }), null, 2)}\n`);
    add('ANIMATION_GUIDE.md', animationGuideMd(config));
    if (config) add('animation-manifest.json', `${JSON.stringify(animationManifest(config), null, 2)}\n`);
  }

  if (input.includeSourceMaterial && input.kind !== 'playable') {
    for (const d of listDocuments(app.db, projectId)) {
      const row = getDocumentRow(app.db, d.id);
      if (row && fs.existsSync(app.storage.abs(row.stored_path))) addFile(`source-material/${d.id}-${slugify(d.originalName.replace(/\.[^.]+$/, ''))}${path.extname(d.originalName).toLowerCase()}`, app.storage.abs(row.stored_path));
    }
    add('source-material/extracted-slides.json', `${JSON.stringify(slides.map((s) => ({ slideNumber: s.slideNumber, hidden: s.hidden, included: s.included, ...effectiveSlideText(s) })), null, 2)}\n`);
    checks.push({ id: 'source-material', label: 'Source material included', status: 'info', detail: 'The original deck, extracted text and speaker notes are included because you selected it.' });
  }

  const preflight: Preflight = {
    kind: input.kind,
    label,
    playable,
    versionId: version?.id ?? null,
    versionNumber: version?.number ?? null,
    blueprintRevisionNumber: blueprintRev?.number ?? null,
    checks,
    missingAssets,
    unresolvedSourceWarnings: unresolved.slice(0, 50),
    unsupportedScenes: unsupported,
    testsRun,
    blocking: false,
  };
  if (input.kind === 'handoff') add('TASKS.md', tasksMd({ nextChanges: input.nextChanges, preflight, blueprint, playable }));

  testsRun.push('Export path safety validation');
  for (const e of entries) safeZipPath(e.path);
  checks.push({ id: 'paths', label: 'Archive paths are relative and safe', status: 'pass', detail: `${entries.length + 1} entries validated.` });
  testsRun.push('Secret scan of exported text files');
  const secretHits = scanForSecrets(entries);
  checks.push({ id: 'secrets', label: 'No API keys, tokens or environment files', status: secretHits.length ? 'fail' : 'pass', detail: secretHits.length ? `Possible secret in ${secretHits.join(', ')}` : 'No keys or tokens found in exported text.' });
  preflight.blocking = checks.some((c) => c.status === 'fail');
  add('PREFLIGHT.md', preflightMarkdown(preflight));
  return { preflight, entries, folder, config, label, branchId };
}

export async function createExport(app: App, projectId: string, input: ExportInput): Promise<ExportRecord> {
  const prepared = prepareExport(app, projectId, input);
  if (prepared.preflight.blocking) {
    throw new HttpError(409, 'preflight_failed', 'The export was stopped by a failing preflight check.', prepared.preflight.checks.find((c) => c.status === 'fail')?.detail, prepared.preflight);
  }
  const id = newExportId();
  const fileName = `${prepared.folder}${prepared.preflight.versionNumber !== null ? `-v${prepared.preflight.versionNumber}` : ''}.zip`;
  const file = path.join(app.storage.exportsRoot, `${projectId}-${id}.zip`);
  const sizeBytes = await writeZip(file, prepared.entries);
  return insertExport(app.db, {
    id,
    projectId,
    kind: input.kind,
    label: prepared.label,
    versionId: prepared.preflight.versionId,
    versionNumber: prepared.preflight.versionNumber,
    filePath: file,
    fileName,
    sizeBytes,
    includeSourceMaterial: input.includeSourceMaterial,
    preflight: prepared.preflight,
    branchId: prepared.branchId,
  });
}
