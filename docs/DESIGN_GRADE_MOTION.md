# Design sources, grade versions and motion

How NEXUS Play Studio combines a lesson deck, a Figma design, your artwork and a grade into one game, and how
screens are animated. For setup and the overall architecture see the [README](../README.md).

- [One project, four setup cards](#one-project-four-setup-cards)
- [Source-to-Screen map](#source-to-screen-map)
- [Figma (read-only)](#figma-read-only)
- [Grade and learning profile](#grade-and-learning-profile)
- [Motion](#motion)
- [Prepare my game](#prepare-my-game)
- [Records and versioning](#records-and-versioning)
- [Exports](#exports)
- [Tests](#tests)
- [Limitations and extension points](#limitations-and-extension-points)

## One project, four setup cards

**Prepare** shows four cards, each with its real status and an **Edit** button:

| Card | What it takes | Default role |
| --- | --- | --- |
| Figma design | A pasted Figma Design link (frames chosen from a thumbnail picker) or uploaded PNG/JPEG/SVG exports. PDF exports go through the deck's PDF reference upload. | Layout and style |
| PPT lesson / storyboard | A `.pptx` through the existing validated pipeline. Legacy `.ppt` is refused with a “save as .pptx” message. | Lesson content (wording, definitions, answers) |
| Game assets | Backgrounds, characters or sprite frames, panels and buttons, objects, sounds — each upload can be marked *Made with ChatGPT* or *another AI image tool*, which is recorded with the file. | Exact artwork |
| Grade & learning profile | “Which grade is this game for?” (1–12 or Custom) and optional details. | Starting suggestions only |

Any useful combination works. Missing pieces are requested, never invented: without lesson slides (or without
Claude) Prepare asks you to write the gameplay yourself in Blueprint; without artwork built-in art is used; without
a design the built-in layout is used.

The **Grade 8 design sample** on the dashboard creates a labelled sample project with a brief and nothing else; its
lesson, exported screens and artwork are added from the Prepare banner (or uploaded yourself), through the same
pipelines as any upload.

## Source-to-Screen map

**Screens** lists the game's screens — the title, every scene and the completion screen — one row each:

- **Linked sources:** several slides can feed one screen and several Figma frames can be states of one screen
  (`default`, `hint`, `correct`, …). Suggestions come from evidence only (shared distinctive words in titles,
  instructions, labels and design text; a frame named *Intro* or *Well done* for the title and end screens).
  Equal counts or matching numbers never link anything. Every row starts unreviewed.
- **Source roles** per screen: lesson wording from *PowerPoint*, *Figma text* or *My wording*; layout from *Figma*
  or the *built-in layout*; exact artwork from *My uploads*, *Figma artwork* or *built-in art*.
- **Design:** *Match* keeps the approved composition; *Adapt* records explicit, reviewed layout changes. *Fit* to
  the 1920×1080 stage is *contain* (letterbox) or *cover* (crop) — never stretched.
- **Background:** an upload, the whole design picture (with a warning that baked-in text or buttons would appear
  twice until you confirm it is clean), or one image layer of the design.
- **Artwork:** character (static picture or sprite with an idle clip), blank instruction panel, text-free button
  art, and decorative placed objects. Native text and controls are always drawn by the game on top.
- **Conflicts:** rule checks compare the lesson with the design — definitions with different quantities
  (“exactly one pair” vs “at least one pair”), opposite statements, different numbers, near-miss labels. Design
  definitions are checked against the whole lesson. Each conflict is shown side by side and resolved explicitly
  (PowerPoint wording, Figma wording, or not a conflict); neither source is edited. A design text the creator
  resolved in favour of the lesson cannot be shown as a layer.
- **Corrections** to learner text are recorded with a reason and used only once marked reviewed.

Each save is a new, immutable map revision (a stale save against an older revision is refused). **Save map
revision** can also apply the layout and artwork to the current game as a new version; otherwise the map is used at
the next build. The live preview beside the design reference (side by side or overlaid with an opacity slider)
shows the row on the real runtime before saving.

## Figma (read-only)

Configured on the server with a personal access token (`FIGMA_ACCESS_TOKEN`, scope `file_content:read`; optional
`current_user:read` for **Settings → Figma → Test connection**). Hosted multi-user *Sign in with Figma* (OAuth) is
reported as **Not configured**. The studio never inherits a Figma connection from ChatGPT, Claude or an editor
plugin, and never writes to Figma.

**What is fetched, and only when you ask:**

| Step | Requests |
| --- | --- |
| Paste a link | The link is validated (https, `figma.com`, Design file/frame, valid key and node id; branch links read the branch). `GET /v1/files/:key?depth=2` lists top-level frames; small thumbnails (`/v1/images`, scale 0.2) fill the picker. |
| Import selected frames (≤ 24) | `GET /v1/files/:key/nodes?ids=…` for the selected frames only, full renders of those frames, and their image fills (`/v1/files/:key/images`). |
| Refresh | The same, again, into a new import that waits for review with a diff (frames added, removed, changed). Approving re-points screen rows to the new snapshots; rejecting keeps the design in use. |

The token is sent only as the `X-Figma-Token` header to the configured API origin — never to download hosts, the
browser, Claude, previews, logs or exports. Downloads follow at most three redirects, only to allowlisted image
hosts, with content-type and size checks (default 20 MB). Responses are cached per project. Rate limits honour
`Retry-After` automatically up to `FIGMA_MAX_AUTO_WAIT_SECONDS` (default 20 s), then stop with a manual retry.
Denied access, missing nodes, expired or invalid tokens, unsupported editor types (FigJam, Slides, Buzz, Sites,
Make), failed renders and unavailable properties are each reported with what to do next. Links in layer names,
annotations or artwork are never followed.

**What is kept:** an immutable snapshot per frame (bounds, editable subset, fonts, warnings, prototype evidence,
checksum), the file key, node id, version and last-modified time, and renders/image fills as library assets with
provenance. Each layer gets a badge:

| Badge | Meaning |
| --- | --- |
| Editable | Text, solid rectangles and image placements the runtime can rebuild. |
| Flattened artwork | Vectors and complex groups: usable only inside a flattened picture. |
| Reference only | Shown beside the game for comparison; never exported. |
| Needs review | Masks, effects, rotation, mixed text styles and similar cases a rebuild may not match. |

Fonts other than the runtime's (Nunito, Inter, Space Grotesk) are substituted with a warning; design fonts are
never redistributed. Prototype links and transitions are design evidence only; Smart Animate is not executed.
`.fig` files cannot be read — paste a link or upload exports. Exported PNG/JPEG/SVG screens are references or
flattened backgrounds: they carry no text, so they are never auto-linked or checked for conflicts.

## Grade and learning profile

“Which grade is this game for?” offers Grades 1–12 and *Custom*, with optional curriculum or board (recorded,
never claimed as verified), language, prerequisites, lesson duration and input device. Nothing about a learner's
age, ability, diagnosis or reading level is inferred.

A grade seeds four **separate** settings from a labelled product preset (*Grades 1–2*, *3–5*, *6–8*, *9–12* —
“starting suggestions, not scientifically validated”): instructional difficulty, reading support, guidance and
motion. Low motion, untimed play, keyboard play and extra guidance are available to every grade.

A **Grade Adaptation Plan** (Claude; demo answers for the bundled sample; preset rules without a key) lists
language, task-step, difficulty, hint, feedback and motion-purpose changes with rationale, source-slide
references, assumptions and a curriculum note; added practice is labelled. Each row shows current → proposed.

- **Presentation only:** accepted wording and guidance changes become a proposal and a new, undoable version.
  Outcomes, questions and answer rules are not touched. Preset rules never write learner text — they only adjust
  density and progress display and leave the rest as notes.
- **Presentation + learning challenge:** learning changes go to a new draft blueprint revision for instructional
  review and approval; nothing reaches the game until it is approved and built.

**Create another grade version** branches the approved game. Each grade version keeps its own blueprint revisions,
screen map, grade profile, motion and version history; sources and asset files are shared. Switching or creating a
version never changes another one.

## Motion

**Animate** has screens and objects on the left (with a motion lock per screen), the live sandboxed stage in the
centre with chips for the selected screen, object, grade and motion profile, and tabs on the right:

- **Animation:** every animation on the screen as a readable rule — e.g. *When Screen 5 · Completion opens → play
  the “celebrate” clip on Swiftee once.* — with origin (you, preset rule, design evidence, from the lesson, AI
  suggestion), purpose (instructional, feedback, decorative), preview, on/off, edit and remove. Presets are
  added by category; the editor exposes trigger, target, delay, duration, easing, repeat, sequence (*after*),
  allowlisted parameters, sound and the reduced-motion fallback (advanced options collapsed).
- **Effects:** motion profile (*Minimal*, *Guided*, *Playful*), pacing (*Calm*, *Standard*), decorative intensity,
  animation sounds, reduced motion (*follow the learner's device* or *always*), low-effects mode, and the
  effects that are not available, with the reason and an alternative.
- **Ask Claude:** “Tell Claude which asset, on which game screen, should do what, and when.” References are resolved
  into screen and object chips; the answer is a validated plan of rows (target, trigger, effect, timing, purpose,
  origin) to accept or reject, preview on the stage, take over with **Edit** (the row becomes your own draft and
  the plan row is declined), then apply. **Suggest motion for this screen** uses the
  deterministic preset rules without AI. Unsupported requests (talking, shaking, full-screen confetti, generated
  limb motion) are listed honestly with alternatives — never faked.

Transport: restart screen, pause/resume, stop motion, speed 0.5×/1×/2×, preview sounds (off by default), pick an
object on the stage, and **Simulate** a game event. Simulation runs only the animations; it never submits answers,
awards points, changes progress or plays sounds unless turned on. The optional timeline is a read-only schedule
per trigger (no scrubbing).

**Triggers** are runtime events only: the screen opens, a button is pressed, the next hint or step is shown, an
object is selected, an object lands on a valid target, the correct answer, an answer that is not right yet, the
screen is completed. Bindings store data only — no scripts, selectors, URLs or formulas.

**Preset registry** (`shared/src/motion/presets.ts`):

| Preset | Label | Category | Purpose | Targets | Triggers | Duration (ms) | Reduced motion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fade-in` | Fade in | Entrance | decorative | any visible object | any the screen emits | 120–1600 | static |
| `slide-in` | Slide in from an edge | Entrance | decorative | any visible object | any the screen emits | 160–1600 | static |
| `pop-in` | Pop in (restrained) | Entrance | decorative | any visible object | any the screen emits | 120–900 | static |
| `outline-highlight` | Outline highlight | Instructional emphasis | instructional | any visible object | any the screen emits | 300–4000 | stepwise |
| `label-reveal` | Step-by-step reveal | Instructional emphasis | instructional | list, text, panel | any the screen emits | 300–6000 | static |
| `path-reveal` | Pointer / path reveal | Instructional emphasis | instructional | any visible object | any the screen emits | 300–4000 | static |
| `attention-cue` | Gentle attention cue | Instructional emphasis | instructional | any visible object | any the screen emits | 300–1500 | stepwise |
| `move-to` | Move to a position | Object movement | instructional | image, sprite, shape, text, card, panel | any the screen emits | 200–4000 | static |
| `move-by` | Move by an amount | Object movement | instructional | image, sprite, shape, text, card, panel, mover | any the screen emits | 200–4000 | static |
| `follow-path` | Follow an approved path | Object movement | instructional | image, sprite, shape, text, card, panel | any the screen emits | 300–6000 | static |
| `press` | Button press | Interaction feedback | feedback | control | button pressed | 80–400 | skip |
| `selected-outline` | Selected-state outline | Interaction feedback | feedback | card, image, sprite, shape | object selected | 150–2000 | stepwise |
| `drop-snap` | Valid-drop snap | Interaction feedback | feedback | card, target | valid drop | 120–700 | skip |
| `success-highlight` | Brief success highlight | Success | feedback | any visible object | any the screen emits | 200–2000 | stepwise |
| `celebration-clip` | Celebration clip | Success | decorative | sprite, image, card, target, panel, screen | any the screen emits | 300–4000 | static |
| `particle-burst` | Small particle burst | Success | decorative | any visible object | any the screen emits | 400–1600 | skip |
| `retry-cue` | Retry outline cue | Retry | feedback | any visible object | not right yet, button pressed | 300–3000 | stepwise |
| `guided-return` | Guided return | Retry | instructional | card, mover | the Reset button | 200–1600 | static |
| `scene-cut` | Cut | Scene transition | decorative | screen | screen opens | 80–200 | unchanged |
| `scene-fade` | Fade | Scene transition | decorative | screen | screen opens | 120–1200 | static |
| `scene-slide` | Directional slide | Scene transition | decorative | screen | screen opens | 160–1200 | static |
| `character-clip` | Character clip | Character animation | decorative | sprite | any the screen emits | 200–6000 | static |

**Static pictures and sprites.** A single PNG can only move, fade, scale or rotate as a whole. Waving, walking or
celebrating needs a sprite sheet with named clips: in **Assets**, *Combine frames* builds a sheet from separate
frame images (the same picture may be used more than once), and the sprite editor names clips (`idle`, `wave`,
`celebrate`, …) with frame ranges, frame rate and looping. Sounds are uploaded or bundled files only.

**Validation and the runtime.** `shared/src/motion/validate.ts` checks screens, targets, preset capabilities,
triggers per screen type, buttons, object filters, parameters, durations, repeats, clips, sounds, dependency
chains (no loops, bounded depth) and budgets (24 per screen, 8 per trigger, 2 particle bursts, one entrance
transition), and warns when two movements or two entrances of the same object would run at the same time.
Animations are keyed by screen and object ids, so reordering scenes keeps them attached (their rules are
renumbered). The trusted runtime runs one cancelable, pausable scheduler per screen: everything is cancelled on
exit, restart or dispose and paused while the page is hidden; dragging takes priority over motion on the dragged
object; hit areas follow the objects; game state never waits on an animation; exits wait at most 1.4 s and
celebrations are skippable; there is no strobe, flashing or screen shake; low-effects mode removes particles.
No frame-rate or accessibility-compliance claims are made — test on learners' devices.

**Applying changes.** The default scope is the selected screen; whole-game changes list every screen they touch.
Locked screens refuse changes (from you or Claude) until unlocked. Edits and accepted plan rows become change ops
that are checked for scope, locks and whole-game validity; a motion plan is applied **all together or not at
all**, against the version it was made for (stale plans are refused), as a new version with Undo.

## Prepare my game

**Prepare my game** stages reviewable proposals without building anything: gameplay (analysis and a draft
blueprint), the screen map, artwork suggestions from your library, the grade plan and a motion plan. **Readiness**
shows real checks — source reviewed, grade plan reviewed, mechanics supported, screens mapped, assets assigned,
motion validated, export checks — and **Approve & build** approves the draft blueprint and builds only the
supported mechanics with the reviewed map, the grade profile and the accepted plan rows. A failed build changes
nothing; the last playable version stays current. Custom mechanics remain blueprint-only with a developer handoff.

## Records and versioning

Migration 2 (`server/src/db/migrations.ts`) adds typed, versioned records, all scoped to a grade version (branch):

| Record | Table | Notes |
| --- | --- | --- |
| Grade version | `game_branches` | Name, parent, forked-from version, current version; `projects.active_branch_id`. |
| GradeProfile | `grade_profiles` | Immutable revisions (trigger); saves need the expected revision. |
| GradeAdaptationPlan | `grade_plans` | Content immutable; per-item decisions; links to proposal, draft blueprint, result version. |
| DesignImport | `design_imports` | File key, branch key, node, version, last modified, editor type, frames, diff, status. |
| DesignFrameSnapshot | `design_frames` | Immutable snapshot with checksum. |
| SourceScreenMapping | `screen_maps` | Immutable numbered revisions. |
| MotionPlan | `motion_plans` | Content immutable; per-row decisions; scope; staged (pre-build) or against a version. |
| AnimationBinding | inside `GameConfig.motion` | Versioned with the game (game versions are immutable). |

Undo/redo uses the proposal system (new versions, never edits). Project duplication copies all of these;
deletion removes them with the project. Jobs `figma_browse`, `figma_import`, `grade_plan`, `motion_suggest` and
`prepare` are persisted with their real progress events; an interrupted job is reported and can be retried.

## Exports

- **Playable game:** only what the game uses — runtime, the approved `GameConfig` (motion included) and the assets
  referenced by screens and animations. Unused or reference-only images, decks, Figma data, prompts and credentials
  are left out. It runs from any static folder or `file://`, with network access blocked by its CSP. The preflight
  adds *Animations validated*, *Runs offline*, *Grade version* and *Only assets in use*, and the secret scan also
  looks for Figma tokens.
- **Claude Code handoff** adds `GRADE_PROFILE.md`, `ANIMATION_GUIDE.md`, `animation-manifest.json` and
  `design-map.json` (frames by id, name, file key and node only — no layer dumps or annotations).

## Tests

| Suite | What it covers |
| --- | --- |
| `tests/unit/shared/motion.test.ts` | Entities, validation (static vs sprite, clips, triggers, guided return, grid units, loops, budgets, simultaneous movements), screen reordering, deterministic suggestions that never reveal answers, scope and lock rules, plan ops in dependency order. |
| `tests/unit/shared/screens.test.ts` | Conflict rules, evidence-only frame linking (numbered frames are not linked), states, scene reordering, layout subset and font substitution, map validation. |
| `tests/unit/shared/grade.test.ts` | Presets, preset-rule plans that never write learner text, presentation vs learning changes. |
| `tests/unit/shared/figma-link.test.ts` | Link validation and stage fitting. |
| `tests/unit/runtime/clock.test.ts` | Pause, resume, cancel and preview speed of the motion clock. |
| `tests/integration/api/figma.test.ts` | Without a token (link validation, exported screens) and against a **local mock** of the Figma API: shallow browse and thumbnails, the token never sent to download hosts, snapshots and fidelity, `Retry-After`, refused tokens, missing nodes, failed renders and download controls, non-Design editors, refresh diff and approval. |
| `tests/integration/api/trapezium-flow.test.ts` | Grade 8 sample with exported screens: Prepare, readiness, Approve & build, motion requests (supported and unsupported), undo, grade versions, exports. |
| `tests/integration/api/trapezium-figma.test.ts` | Grade 8 sample with the mock Figma design: selective fetching, duplicate uploads, map suggestion, definition conflict, reviewed build, handoff design map. |
| `tests/e2e/trapezium.spec.ts` | The whole Grade 8 scenario in the browser (see below). |

The browser scenario uploads the sample PPTX, imports the sample design from the **mock** Figma API, uploads
Swiftee's frames, background, blank panel and button art as ChatGPT artwork, combines the frames into a sprite with
`idle`/`wave`/`celebrate` clips, sets Grade 8, prepares, accepts the grade suggestions, reviews the map (resolving
the “exactly one pair” conflict in favour of the lesson), builds, adds an entrance, an instructional highlight,
valid-drop feedback and one celebration, checks that nothing else changed, simulates repeated events, stops,
pauses, restarts, undoes and reloads, asks for unsupported motion, plays through with and without reduced motion,
exports and plays the game from a static server with no outside requests, and creates an independent Grade 6
version.

Passing tests against the mocks show the code handles the API contracts as modelled; they are **not** live Figma
or Claude verification. Use **Settings → Test connection** for each with real credentials.

## Limitations and extension points

- Live Figma and Claude were not exercised in this environment; only their local mocks were.
- Hosted OAuth (*Sign in with Figma*) is not implemented; a server token is required for link import.
- Figma import keeps an editable subset (text, solid rectangles, image placements); auto layout, constraints,
  components and variants are not rebuilt, and complex vectors stay flattened.
- Motion presets are the only motion; there is no keyframe editor, timeline scrubbing, path drawing UI, lip sync or
  generated animation. New presets are added to `shared/src/motion/presets.ts` (schema, capabilities, validation)
  and `runtime/src/motion/director.ts` (effect).
- Grade presets are product suggestions, not research-based rules; curriculum alignment is never verified.
- New mechanics still need a new allowlisted scene type in the runtime (see `docs/CUSTOM_CODE_BUILDER.md`).
