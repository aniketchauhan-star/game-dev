# NEXUS Play Studio

**From slides to playable learning.** A local, single-creator studio that turns a PowerPoint lesson into a
playable learning game:

**Import deck → Review learning content → Describe game → Approve blueprint → Build → Playtest → Refine → Export**

Claude (through the official Anthropic TypeScript SDK, on the server only) proposes the learning map, the
blueprint and refinements. You review and approve everything; games are built by trusted templates from
validated data, never from generated code.

Three mechanics are fully playable: **coordinate navigation**, **drag-and-match** and **sequence sorting**.
Any other idea gets an editable, approvable blueprint and a **developer handoff** instead of a fake game.

One project can also combine a **Figma design** (read-only; or exported screens), your **artwork** (including
ChatGPT-made art, sprite frames and clips) and a **grade** (with separate grade versions), map them screen by
screen, and **animate** the game with validated motion presets — see
[docs/DESIGN_GRADE_MOTION.md](docs/DESIGN_GRADE_MOTION.md).

---

## Contents

- [What works](#what-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Connecting Claude](#connecting-claude)
- [Optional slide rendering](#optional-slide-rendering)
- [Scripts](#scripts)
- [Exports](#exports)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Hosting boundaries](#hosting-boundaries)
- [Testing](#testing)
- [Screenshots](#screenshots)
- [Known limitations](#known-limitations)
- [Project layout](#project-layout)

## What works

| Area | Status |
| --- | --- |
| Dashboard: search, rename, duplicate (deep copy), confirmed delete, bundled sample | Working |
| Create flow (Source → Game brief → Visual direction → Review), autosaved | Working |
| PPTX ingestion (order, hidden slides, notes, tables, images, groups, equations, warnings, limits, malicious-package rejection) | Working |
| Optional PDF export as visual reference | Working |
| Source review: search, filters, edits with history and revert, locks, required examples, review labels, coverage, stale invalidation | Working |
| Hand-authored blueprint (no AI): edit overview and scenes, approve (immutable), build | Working |
| Claude analysis, blueprint generation, scene regeneration, refinement, Q&A | Implemented against the real SDK; **tested only against a local mock of the API** — needs your key to verify live |
| Builder: GameConfig → trusted runtime, seeded randomness, keyboard/touch/mouse/non-drag input, hints, mute, reduced motion | Working |
| Sandboxed preview + playtest with diagnostics | Working |
| Proposals: before/after, Apply / Reject / Undo, scopes, locks, stale detection | Working (demo templates without a key; Claude with a key) |
| Asset library: categories, metadata, alpha checkerboard, SVG screening + rasterizing, sprite settings, replace keeps placement, copyable prompts | Working (no image generation service is called) |
| Exports: playable ZIP, source package, Claude Code handoff, developer handoff, preflight | Working |
| Slide rendering via LibreOffice / Docker | Implemented; **untested here** (LibreOffice was not installed) |
| Prepare my game: four setup cards (Figma design, PPT lesson, game assets, grade), staged proposals, readiness checks, Approve & build | Working |
| Figma import (read-only, PAT on the server): link validation, frame picker, snapshots with fidelity badges, renders and image fills with provenance, refresh with diff and approval | Implemented; **tested only against a local mock of the Figma API** — needs your token to verify live. OAuth: not configured |
| Exported screens (PNG/JPEG/SVG) as references or flattened backgrounds | Working |
| Source-to-Screen map: explicit slide/frame/state links, source roles, conflict checks, corrections, revisions, side-by-side and overlay compare | Working |
| Grade profile, labelled presets, Grade Adaptation Plan (presentation only / learning challenge), grade versions | Working (preset rules or demo answers without a key; Claude with a key) |
| Animate: preset registry, readable rules, triggers, sequences, reduced motion, locks, simulation, Ask Claude motion plans, Suggest motion (no AI) | Working (Claude requests tested against the mock only) |
| Sprites: combine frames into a sheet, named clips, clip preview | Working |
| Custom code builder | **Disabled** extension point only — see [docs/CUSTOM_CODE_BUILDER.md](docs/CUSTOM_CODE_BUILDER.md) |

## Requirements

- **Node.js 24 or later** (developed and tested on Node 26.7). The server uses the built-in `node:sqlite`.
- npm.
- Optional: LibreOffice (slide images) — see [below](#optional-slide-rendering).
- For browser tests: Playwright's Chromium (`npx playwright install chromium`).

## Quick start

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. `npm run dev` starts four processes: the runtime bundler (watch), the API
(`127.0.0.1:5174`), the background worker, and the Vite studio server.

Static file servers such as VS Code's **Live Server** cannot run the studio (they show “Cannot GET /”). The
`index.html` at the repository root is only a pointer for them: it opens the running studio, or shows how to
start it.

No key is needed to start: choose **Try sample project** to open the bundled
“Air Traffic Control — Coordinate Mission” sample (clearly labelled demo content), **Grade 8 design sample** for the
trapezium lesson with exported screens, artwork and motion, or **Create game** to import your own `.pptx` and
build a game by hand.

A production-style run serves the built studio from the API port:

```sh
npm run build      # runtime + studio
npm start          # API + worker on http://127.0.0.1:5174
```

## Configuration

Copy `.env.example` to `.env` (git-ignored). Everything is optional. The most important settings:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables Claude. Read only by the server processes. |
| `CLAUDE_MODEL` | Model id (suggested `claude-opus-5-5`). Verified with the Models API before any AI job runs. If empty, choose a model in **Settings**. |
| `CLAUDE_PRICING_FILE` | Optional dated pricing for cost *estimates* (see `config/pricing.example.json`). Without it only token counts are shown. |
| `NEXUS_DATA_DIR` | Where projects, uploads, exports and `nexus.sqlite` live (default `data/`, git-ignored). |
| `MAX_UPLOAD_MB`, `MAX_SLIDES`, … | Import limits (defaults: 40 MB, 80 slides, 300 MB expanded, 4000 entries, 8 MB per XML part, 50 MP images). |
| `RENDERER`, `SOFFICE_PATH`, `RENDERER_DOCKER_IMAGE` | Optional slide rendering. |
| `FIGMA_ACCESS_TOKEN` | Optional Figma personal access token (`file_content:read`) for read-only link import. Without it, upload exported screens. |
| `FIGMA_MAX_AUTO_WAIT_SECONDS`, `FIGMA_TIMEOUT_MS`, `FIGMA_MAX_DOWNLOAD_MB`, `FIGMA_ASSET_HOSTS` | Figma rate-limit waiting, timeouts, download size and extra image hosts. |

## Connecting Claude

1. Put `ANTHROPIC_API_KEY=…` in `.env` (and optionally `CLAUDE_MODEL=claude-opus-5-5`).
2. Restart `npm run dev`.
3. Open **Settings → Claude connection** and choose **Test connection** (Models API, no generation) or
   **Send a tiny test request**.

The connection shows *Not configured*, *Configured — not verified yet*, *Configured* or *Connection failed*.
AI jobs only run once the model has been verified.

What Claude receives is shown on the **Review** step before analysis: the included slides' text (titles, body,
tables, equation text, image descriptions), optionally speaker notes, optionally slide images you explicitly
authorise per slide, and your brief. Hidden/excluded slides, files, keys and other projects are never sent.
Deck content is treated as untrusted source material, never as instructions.

Calls use streaming, structured outputs (JSON Schema) validated again with Zod, bounded retries and repair
attempts, refusal/truncation handling, cancellation, and token usage tracking. A failed AI request is shown as
failed — it is never replaced by fake output.

**Demo mode.** Without a key, the bundled sample replays prepared fixtures and a few keyword-matched change
templates. Everything it produces is labelled *Demo mode — sample content*.

## Optional slide rendering

Without a renderer, slides are shown as an **Extracted content view** (positions and text from the deck,
clearly not a screenshot), and you can upload a PDF export of the deck for visual reference.

- **LibreOffice:** install it (macOS: `brew install --cask libreoffice`). It is auto-detected, or set
  `SOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice`.
- **Docker:** `RENDERER=docker` and `RENDERER_DOCKER_IMAGE=<an image with soffice>`. Runs with
  `--network none --read-only`, memory/CPU/process limits.

**Settings → Slide rendering** shows the true status; use **Check again** after installing.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runtime watcher, API, worker and studio (Vite) together |
| `npm run build` | Build the game runtime (`dist/runtime`) and the studio (`dist/studio`) |
| `npm start` | API + worker in production mode (serves `dist/studio`) |
| `npm run typecheck` | TypeScript over the whole repo |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run test:unit` / `npm run test:integration` | One suite |
| `npm run test:e2e` | Browser tests (Playwright; starts its own servers on separate ports) |
| `npm run fixtures:sample` | Regenerate `fixtures/sample/air-traffic-control.pptx` |
| `npm run fixtures:trapezium` | Regenerate the Grade 8 trapezium sample (lesson, exported screens, artwork, mock Figma data) |
| `npm run check:contrast` | Check studio colour tokens against WCAG contrast targets |

## Exports

Exports are files you download; nothing is published or pushed anywhere. Each export runs a **preflight**
(schema, completable scenes, assets, unresolved source warnings, content origin, path safety, secret scan)
that is included as `PREFLIGHT.md`.

| Export | Contents |
| --- | --- |
| **Playable game (.zip)** | `index.html`, `game.config.js`, runtime and assets. Works from any static host or sub-folder, and from `file://`. No server, login or key. |
| **Source package (.zip)** | `game.config.json`, asset map + originals, runtime and its TypeScript source, a dependency-free `build.mjs` / `serve.mjs`. |
| **Claude Code handoff (.zip)** | The source package plus `README.md`, `CLAUDE.md`, `GAME_DESIGN.md`, `TASKS.md`, `ASSET_GUIDE.md`, `GRADE_PROFILE.md`, `ANIMATION_GUIDE.md`, `animation-manifest.json`, `design-map.json`, `blueprint.json`, `source-map.json`. |
| **Developer handoff (.zip)** | For blueprint-only ideas: the approved design, tasks, asset guide, source map and the runtime source as the reference for adding a new scene type — no fake build. |

Exports contain only the assets the game uses (animations included). API keys, Figma tokens, environment files,
studio conversations and Claude requests, Figma files and annotations, reference-only design images, source decks
and speaker notes are never included — decks and notes only if you explicitly select **Include source material**
(source/handoff exports only). The preflight also validates every animation and checks that the game runs offline.

## Architecture

```
studio/     React 19 + TypeScript studio (Vite). Talks only to /api and embeds /preview in a sandboxed iframe.
server/     Fastify API (index.ts) and a separate worker process (worker.ts) sharing one SQLite database.
  ingest/   ZIP/XML/PPTX/PDF/media readers with limits and rejection of unsafe content.
  claude/   The only code that talks to Claude (gateway, prompts, schemas).
  figma/    Read-only Figma REST adapter (allowlisted hosts, bounded downloads, rate limits) and frame snapshots.
  jobs/     Persisted jobs with leases, heartbeats, events, idempotency and per-stage resumability.
  build/    Deterministic blueprint → GameConfig compiler (no AI).
  export/   Export packages, docs and preflight.
shared/     Zod schemas and pure logic shared by all parts: rules, attainability, coordinates, seeded RNG,
            screen-map suggestions and conflict checks, motion presets and validation, grade presets.
runtime/    Framework-free game runtime (bundled as a classic script for static hosting), including the
            per-screen motion director, sprite clips and the cancelable motion clock.
fixtures/   The sample deck generator, raw ZIP writer for malicious-package tests, sample fixtures.
```

- **Data:** `data/nexus.sqlite` (WAL) plus a project-scoped file store `data/projects/<id>/…` outside any public
  directory. Steps that write both files and rows (uploads, duplication, exports) write files first and commit
  the database rows last, so an interrupted step does not leave a half-created record.
- **Jobs:** queued → running → succeeded / failed / cancelled / interrupted. The worker claims jobs with a lease
  and heartbeats; after a crash, running jobs become *interrupted* (never silently re-run) and can be retried.
  Progress shown in the studio is the real event log — no percentages or invented timings.
- **Versions:** approved blueprints and game versions are immutable (enforced by database triggers). Builds use
  the exact approved revision; refinements and undo create new versions.
- **Games:** a validated `GameConfig` rendered by the trusted runtime. Answer rules are allowlisted data
  evaluated by `shared/src/rules.ts` — no `eval`, no model-provided formulas.

## Security model

- The API key is read only in `server/src/secrets.ts`, redacted from errors, and never returned by the API,
  stored, logged, sent to the preview, or exported. `dangerouslyAllowBrowser` is never used.
- The Figma token follows the same rules and is sent only as the `X-Figma-Token` header to the Figma API —
  never to image download hosts, Claude, the browser, logs or exports. Figma is only read, never written.
- The API binds to `127.0.0.1`. Requests must carry an allowed `Host` (else 421), and state-changing requests
  need the `X-Nexus-CSRF` header plus a same-origin `Origin` / `Sec-Fetch-Site`.
- Uploads are validated by content, not extension. ZIP entries are checked for traversal, absolute paths,
  symlinks, encryption, duplicates, size/ratio bombs and entry counts; XML is parsed without DTDs or entity
  expansion; macros and OLE files are rejected; external relationships are never followed.
- SVG uploads with scripts, event handlers, `foreignObject` or external references are rejected; others are
  rasterized. Uploaded SVG markup is never inserted into the studio DOM.
- The game preview runs in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), served with its own
  CSP that blocks network access, and talks to the studio only over a `MessageChannel` with a per-session nonce
  and schema-checked messages.

## Hosting boundaries

NEXUS Play Studio is a **local, single-user tool with no authentication**. Keep it on loopback.
`ALLOWED_HOSTS` can add host names (for example a local reverse proxy), and binding to a non-loopback `HOST`
is refused unless `NEXUS_ALLOW_REMOTE=yes-i-understand` is set — do not do that on a shared network: anyone who
can reach the port can read and change every project and spend your Claude credits. Exported **playable games**
are static files and are safe to host anywhere.

## Testing

```sh
npm run typecheck
npm test                         # unit + integration
npx playwright install chromium  # once
npm run test:e2e                 # browser tests
```

- **Unit:** ingestion (including malicious packages), rules, coordinates, attainability, RNG, change proposals,
  blueprint checks, coverage, palettes, compiler, export paths.
- **Integration:** the API and worker against temporary data directories (security headers, uploads, jobs,
  versions, exports and secret scanning) and the Claude gateway against a **local mock** of the Anthropic API
  (streaming, structured output, refusals, truncation, malformed output, rate limits, timeouts, cancellation).
- **Browser:** the sample flow, all three mechanics in the sandboxed preview, preview isolation, an exported
  game served from a sub-folder, and the Grade 8 trapezium scenario end to end (uploads, mock Figma design,
  sprite clips, screen map and conflict, grade suggestions, four animations, playtest with reduced motion,
  offline export, a second grade version).
- **Design, grade and motion:** unit tests for map suggestions, conflicts, layout, grade plans, motion
  validation and suggestions, and the motion clock; integration tests for the Figma adapter against a **local
  mock** of the Figma API and for both Grade 8 sample flows. Details in
  [docs/DESIGN_GRADE_MOTION.md](docs/DESIGN_GRADE_MOTION.md#tests).

The live Anthropic and Figma APIs are not exercised by the test suite. Verify them with **Settings → Test
connection** once you add a key or token.

On macOS, idle sleep pauses running processes and makes timing-sensitive tests (timeouts, stalled streams)
fail or take minutes; run long suites as `caffeinate -i npm test` when the machine may go idle.

## Screenshots

Key screens at 1440×900, captured from a fresh data directory without a Claude key, are in
[docs/screenshots](docs/screenshots): dashboard, the four create steps, source review and learning map, blueprint
overview, storyboard and scene editor, build preview and all three mechanics, a demo proposal, the asset library,
export preflight and settings. Screens 21–32 show the Grade 8 trapezium sample with its design read from the
**local Figma mock**: Prepare (setup cards, staged proposals, grade plan), the Source-to-Screen map (side by side,
overlay, the definition conflict), Animate (rules and timeline, Ask Claude with unsupported requests, effects),
sprite clips, the export preflight with motion checks, Settings → Figma, and the built game.

## Known limitations

- Live Claude calls have only been tested against a local mock; run Settings → Test connection with a real key.
- Live Figma has only been tested against a local mock; hosted Figma OAuth is not implemented. Figma import keeps
  an editable subset (text, solid rectangles, image placements); other layers stay flattened or reference-only.
- Motion is limited to the preset registry (no keyframe editor or timeline scrubbing, no lip sync or generated
  animation); no frame-rate or accessibility-compliance claims are made.
- Slide rendering (LibreOffice/Docker) was not available in the development environment and is untested.
- Charts, SmartArt layout, animations and some layout semantics are reported as warnings rather than fully
  interpreted. Legacy `.ppt` must be saved as `.pptx`.
- The studio is desktop-first; phones get review, playtest and light edits.
- No accounts, sharing, billing or publishing — by design for this version.

## Project layout

```
.env.example            server configuration template (blank credentials)
config/                 pricing example (placeholders only)
docs/                   DESIGN_GRADE_MOTION.md, CUSTOM_CODE_BUILDER.md, screenshots/
examples/exports/       example exports: Air Traffic (playable, source, Claude Code handoff), Quadrant Memory
                        (developer handoff for a custom mechanic), Trapezium Quest (playable + handoff with grade
                        profile, design map and animation manifest)
fixtures/               sample deck, Grade 8 trapezium sample (lesson, screens, art, Figma mock data) + generators
runtime/ server/ shared/ studio/
tests/unit tests/integration tests/e2e
```
