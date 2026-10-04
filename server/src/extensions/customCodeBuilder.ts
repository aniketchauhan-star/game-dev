import type { Blueprint } from '@shared/schemas/blueprint.ts';

/**
 * Extension point for a future custom-code builder: an isolated worker (for
 * example one driven by the Claude Agent SDK) that could implement mechanics
 * the trusted templates do not support.
 *
 * It is DISABLED in this version. The studio never executes generated code:
 * blueprint-only ideas end in a developer handoff instead. This file only fixes
 * the contract and the isolation policy any future implementation must meet —
 * see docs/CUSTOM_CODE_BUILDER.md.
 */

export interface CustomBuildRequest {
  projectId: string;
  /** Approved, immutable revision — a builder never works from a draft. */
  blueprintRevisionId: string;
  blueprint: Blueprint;
  /** Copies of validated display assets. Originals, decks and speaker notes are never passed in. */
  assets: ReadonlyArray<{ id: string; file: string; mime: string; bytes: Uint8Array }>;
  /** Creator-written change requests (untrusted text, never instructions to the host). */
  nextChanges: string;
}

export interface CustomBuildArtifact {
  /** Static files only. Reviewed in an isolated origin; never served from the studio origin. */
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
  /** Human-readable account of what was built and which checks ran. */
  report: string;
}

/** The isolation every implementation must enforce before it may be enabled. */
export interface SandboxPolicy {
  /** No network from the sandbox; package installs come from a pre-approved, pinned set. */
  network: 'none';
  /** Tools the agent may call, by name. Anything else is refused. */
  allowedTools: readonly string[];
  /** Host secrets (API keys, .env, database, other projects) are never mounted or passed in. */
  hostSecrets: 'none';
  cpuSeconds: number;
  memoryMb: number;
  wallClockSeconds: number;
  maxOutputBytes: number;
  /** Generated output is previewed only from a separate, cookieless origin with a strict CSP. */
  previewOrigin: 'isolated';
  /** Nothing is exported or published until the creator reviews and approves the result. */
  creatorApprovalRequired: true;
}

export const REQUIRED_SANDBOX_POLICY: SandboxPolicy = {
  network: 'none',
  allowedTools: ['read_file', 'write_file', 'list_files', 'run_tests'],
  hostSecrets: 'none',
  cpuSeconds: 300,
  memoryMb: 1024,
  wallClockSeconds: 900,
  maxOutputBytes: 25 * 1024 * 1024,
  previewOrigin: 'isolated',
  creatorApprovalRequired: true,
};

export type CustomBuilderStatus = { enabled: false; reason: string } | { enabled: true; policy: SandboxPolicy };

export interface CustomCodeBuilder {
  readonly id: string;
  status(): CustomBuilderStatus;
  build(request: CustomBuildRequest, signal: AbortSignal): Promise<CustomBuildArtifact>;
}

export const CUSTOM_BUILDER_DISABLED_REASON =
  'Not available in this version. Ideas outside the three supported mechanics get an approved blueprint and a developer handoff; no generated code is run.';

export class DisabledCustomCodeBuilder implements CustomCodeBuilder {
  readonly id = 'disabled';
  status(): CustomBuilderStatus {
    return { enabled: false, reason: CUSTOM_BUILDER_DISABLED_REASON };
  }
  async build(): Promise<CustomBuildArtifact> {
    throw new Error(CUSTOM_BUILDER_DISABLED_REASON);
  }
}

/** The only registered builder. Enabling one is a code change reviewed against the policy above. */
export function customCodeBuilder(): CustomCodeBuilder {
  return new DisabledCustomCodeBuilder();
}
