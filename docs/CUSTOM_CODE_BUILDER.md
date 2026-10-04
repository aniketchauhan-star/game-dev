# Custom code builder — boundary (disabled)

NEXUS Play Studio builds games only from validated data (`GameConfig`) rendered by trusted templates. Ideas that
need a new kind of interaction currently end in an approved blueprint and a **developer handoff**.

A *custom code builder* — an isolated worker, for example one driven by the Claude Agent SDK, that writes code for
a new mechanic — is a possible future addition. This version ships **only the extension point, and it is
disabled**: `server/src/extensions/customCodeBuilder.ts` registers `DisabledCustomCodeBuilder`, and the studio never
executes generated code. **Settings → Custom code builder** reports this status from `/api/health`.

This document fixes the rules any future implementation must meet before it can be enabled.

## Contract

```ts
interface CustomCodeBuilder {
  readonly id: string;
  status(): { enabled: false; reason: string } | { enabled: true; policy: SandboxPolicy };
  build(request: CustomBuildRequest, signal: AbortSignal): Promise<CustomBuildArtifact>;
}
```

- **Input** (`CustomBuildRequest`): an *approved, immutable* blueprint revision, copies of validated display
  assets, and the creator's change requests. Never drafts, original uploads, decks, speaker notes, studio
  conversations, other projects, the database, or any secret.
- **Output** (`CustomBuildArtifact`): static files (HTML/JS/CSS/assets) and a written report of what was built
  and which checks ran. Output is data to be reviewed, not something the studio runs.

## Required isolation (`REQUIRED_SANDBOX_POLICY`)

| Requirement | Rule |
| --- | --- |
| Separate process / container | The agent runs outside the API and worker processes, in a disposable sandbox (container or VM) with its own filesystem. |
| No network | `network: none`. Dependencies come from a pre-approved, pinned set baked into the image. |
| No host secrets | The Anthropic key the *studio* uses, `.env`, the SQLite database and the data directory are never mounted or passed in. If the builder itself needs model access, it uses a separate, scoped credential injected by the sandbox platform. |
| Allowlisted tools | The agent may only call named tools (e.g. `read_file`, `write_file`, `list_files`, `run_tests`) scoped to its workspace. No shell beyond the test runner, no package installs, no outbound requests. |
| Resource limits | CPU time, memory, wall-clock time and total output size are capped (see the policy constants); exceeding a limit fails the build. |
| Untrusted inputs | Deck text, notes, file names, asset metadata and change requests are data, never instructions that alter the agent's tools or permissions. |
| Isolated preview | Generated output is previewed only from a separate, cookieless origin with a strict CSP (no network), inside `sandbox="allow-scripts"` without `allow-same-origin` — never from the studio origin. |
| Deterministic checks | The same attainability, accessibility (keyboard, non-drag alternative, text + icon feedback, reduced motion) and secret-scan checks as the trusted templates must pass. |
| Creator approval | Nothing is exported, published or merged into a project version until the creator has reviewed the result and approved it. There is no auto-publish. |

## Enabling a builder

Enabling is a code change, not a setting: replace the factory in `customCodeBuilder()` with an implementation that
returns `{ enabled: true, policy }` where `policy` is at least as strict as `REQUIRED_SANDBOX_POLICY`, add tests
for every row above, and update this document.
