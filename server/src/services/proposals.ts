import { applyChangeOps, type ChangeOp, type ChangeScope } from '@shared/schemas/proposal.ts';
import type { GameVersion, Proposal } from '@shared/schemas/records.ts';
import type { App } from '../app.ts';
import { listAssetRows, toAsset } from '../db/assets.ts';
import { activeBranchId, getBranchRow } from '../db/branches.ts';
import { attachLibraryAssets } from './attachAssets.ts';
import { insertMessage } from '../db/misc.ts';
import { getProjectRow } from '../db/projects.ts';
import { getProposal, getVersion, insertProposal, insertVersion, setProposalStatus } from '../db/versions.ts';
import { badRequest, conflict } from '../errors.ts';

/**
 * Applying, rejecting and undoing structured changes. Every apply happens in a
 * single transaction against the exact base version; if the project moved on,
 * the proposal is marked stale instead of overwriting newer work.
 */

export function applyProposal(app: App, proposalId: string): { proposal: Proposal; version: GameVersion } {
  const { db } = app;
  // A refusal still records the proposal's new status (stale / failed), so the transaction
  // returns the error and it is thrown only after the status change has been committed.
  const outcome = db.tx((): { error: Error } | { ok: { proposal: Proposal; version: GameVersion } } => {
    const p = getProposal(db, proposalId);
    if (p.status !== 'proposed') return { error: conflict(`This proposal is already ${p.status}.`) };
    // A proposal belongs to the grade version of its base; it is never applied to another one.
    const baseBranch = getVersion(db, p.baseVersionId).branchId ?? activeBranchId(db, p.projectId);
    if (baseBranch !== activeBranchId(db, p.projectId)) {
      return { error: conflict(`This change was proposed for the grade version “${getBranchRow(db, baseBranch).name}”.`, 'Switch to that grade version to apply it. Nothing was changed.') };
    }
    const branchCurrent = getBranchRow(db, baseBranch).current_version_id;
    if (branchCurrent !== p.baseVersionId) {
      setProposalStatus(db, p.id, 'stale');
      const current = branchCurrent ? getVersion(db, branchCurrent) : null;
      return {
        error: conflict(
          `This proposal was made for version ${p.baseVersionNumber}, but the game is now at version ${current?.number ?? '—'}.`,
          'Nothing was changed. Ask again so the change is proposed against the latest version.',
        ),
      };
    }
    const base = getVersion(db, p.baseVersionId);
    const result = applyChangeOps(base.config, p.ops, { scope: p.scope });
    if (!result.ok) {
      setProposalStatus(db, p.id, 'failed', null, result.results);
      return {
        error: badRequest(
          result.changed ? `The changed game failed validation: ${result.validationErrors[0] ?? 'unknown problem'}` : 'None of the proposed changes can be applied (they are locked, out of scope, invalid or already in place).',
          'The previous version is still current.',
        ),
      };
    }
    const version = insertVersion(db, {
      projectId: p.projectId,
      config: result.config,
      origin: p.origin === 'creator' ? 'manual-edit' : 'refinement',
      summary: p.summary,
      blueprintRevisionId: base.blueprintRevisionId,
      blueprintRevisionNumber: base.blueprintRevisionNumber,
      parentVersionId: base.id,
      demo: base.demo,
    });
    setProposalStatus(db, p.id, 'applied', version.id, result.results);
    const applied = result.results.filter((r) => r.status === 'applied').length;
    const skipped = result.results.length - applied;
    insertMessage(db, {
      projectId: p.projectId,
      role: 'system',
      text: `Applied ${applied} change${applied === 1 ? '' : 's'} → version ${version.number}.${skipped ? ` ${skipped} change(s) were skipped (locked, out of scope or invalid).` : ''}`,
      scope: { kind: p.scope.kind, sceneId: p.scope.sceneId, slideId: null },
      area: 'build',
      origin: 'system',
      proposalId: p.id,
    });
    return { ok: { proposal: getProposal(db, p.id), version } };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.ok;
}

export function rejectProposal(app: App, proposalId: string): Proposal {
  const p = getProposal(app.db, proposalId);
  if (p.status !== 'proposed') throw conflict(`This proposal is already ${p.status}.`);
  setProposalStatus(app.db, proposalId, 'rejected');
  return getProposal(app.db, proposalId);
}

/** Undo an applied proposal by restoring its base configuration as a new version (history is kept). */
export function undoProposal(app: App, proposalId: string): { proposal: Proposal; version: GameVersion } {
  const { db } = app;
  return db.tx(() => {
    const p = getProposal(db, proposalId);
    if (p.status !== 'applied' || !p.resultVersionId) throw conflict('Only an applied change can be undone.');
    const resultBranch = getVersion(db, p.resultVersionId).branchId ?? activeBranchId(db, p.projectId);
    if (resultBranch !== activeBranchId(db, p.projectId)) throw conflict(`This change belongs to the grade version “${getBranchRow(db, resultBranch).name}”.`, 'Switch to that grade version to undo it.');
    if (getBranchRow(db, resultBranch).current_version_id !== p.resultVersionId) {
      throw conflict('Newer changes were made after this one, so it cannot be undone on its own.', 'Use the version menu to restore an earlier version instead.');
    }
    const base = getVersion(db, p.baseVersionId);
    const version = insertVersion(db, {
      projectId: p.projectId,
      config: base.config,
      origin: 'undo',
      summary: `Undo: ${p.summary}`,
      blueprintRevisionId: base.blueprintRevisionId,
      blueprintRevisionNumber: base.blueprintRevisionNumber,
      parentVersionId: p.resultVersionId,
      demo: base.demo,
    });
    setProposalStatus(db, p.id, 'undone');
    insertMessage(db, {
      projectId: p.projectId,
      role: 'system',
      text: `Undid “${p.summary}” → version ${version.number} (same as version ${base.number}).`,
      scope: { kind: p.scope.kind, sceneId: p.scope.sceneId, slideId: null },
      area: 'build',
      origin: 'system',
      proposalId: p.id,
    });
    return { proposal: getProposal(db, p.id), version };
  });
}

/** The creator's own inspector edit: recorded as a creator proposal and applied atomically. */
export function applyManualEdit(app: App, projectId: string, input: { baseVersionId: string; ops: ChangeOp[]; scope: ChangeScope; summary: string }): { proposal: Proposal; version: GameVersion } {
  const base = getVersion(app.db, input.baseVersionId);
  if (base.projectId !== projectId) throw badRequest('That version belongs to another project.');
  // Library assets the edit needs are packaged from the stored records (never from the request).
  const ops = attachLibraryAssets(input.ops, base.config, listAssetRows(app.db, projectId).map((r) => toAsset(r)));
  input = { ...input, ops };
  const preview = applyChangeOps(base.config, input.ops, { scope: input.scope });
  const proposal = insertProposal(app.db, {
    projectId,
    baseVersionId: base.id,
    scope: input.scope,
    request: input.summary,
    summary: input.summary,
    explanation: 'Edited in the inspector.',
    ops: input.ops,
    results: preview.results,
    origin: 'creator',
    model: null,
    jobId: null,
  });
  return applyProposal(app, proposal.id);
}

export function restoreVersion(app: App, projectId: string, versionId: string): GameVersion {
  const { db } = app;
  return db.tx(() => {
    const target = getVersion(db, versionId);
    if (target.projectId !== projectId) throw badRequest('That version belongs to another project.');
    const project = getProjectRow(db, projectId);
    if (project.current_version_id === versionId) throw conflict(`Version ${target.number} is already current.`);
    const branch = activeBranchId(db, projectId);
    if (target.branchId && target.branchId !== branch) {
      throw conflict(`Version ${target.number} belongs to the grade version “${getBranchRow(db, target.branchId).name}”.`, 'Switch to that grade version to restore it, or create a new grade version from it.');
    }
    return insertVersion(db, {
      projectId,
      config: target.config,
      origin: 'restore',
      summary: `Restored version ${target.number}`,
      blueprintRevisionId: target.blueprintRevisionId,
      blueprintRevisionNumber: target.blueprintRevisionNumber,
      parentVersionId: project.current_version_id,
      demo: target.demo,
      branchId: branch,
    });
  });
}
