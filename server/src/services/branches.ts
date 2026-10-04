import { gradeLabel, type GradeProfile } from '@shared/schemas/grade.ts';
import type { BranchSummary } from '@shared/schemas/records.ts';
import type { App } from '../app.ts';
import { activeBranchId, getBranch, getBranchRow, insertBranch, setActiveBranch } from '../db/branches.ts';
import { currentGradeProfile, saveGradeProfile } from '../db/grade.ts';
import { approveBlueprint, approvedBlueprint, getBlueprintSnapshot, insertBlueprintRevision } from '../db/learning.ts';
import { insertMessage } from '../db/misc.ts';
import { currentScreenMap, insertScreenMap } from '../db/screens.ts';
import { currentVersion, insertVersion } from '../db/versions.ts';
import { conflict } from '../errors.ts';

/**
 * "Create another grade version": branch the current approved game. The new
 * grade version gets its own copy of the approved blueprint revision, screen
 * map, grade profile and the current game (motion included), so it can change
 * independently. Sources and immutable assets stay shared. The earlier grade
 * version is never modified.
 */
export function createGradeVersion(app: App, projectId: string, input: { name: string; profile: GradeProfile | null; fromBranchId?: string | null }): BranchSummary {
  const { db } = app;
  return db.tx(() => {
    const sourceBranch = input.fromBranchId ?? activeBranchId(db, projectId);
    const src = getBranchRow(db, sourceBranch);
    if (src.project_id !== projectId) throw conflict('That grade version belongs to another project.');
    const version = currentVersion(db, projectId, sourceBranch);
    const approved = approvedBlueprint(db, projectId, sourceBranch);
    if (!version || !approved) {
      throw conflict('Build an approved game before creating another grade version.', 'A grade version starts from the current playable game of an approved blueprint.');
    }
    const sourceProfile = currentGradeProfile(db, sourceBranch);
    const profile = input.profile ?? sourceProfile?.profile ?? null;
    const name = input.name.trim() || (profile ? `${gradeLabel(profile)} version` : 'New grade version');
    const branchId = insertBranch(db, { projectId, name, parentBranchId: sourceBranch, forkedFromVersionId: version.id });

    // Blueprint: an approved copy in the new grade version (same content, own history).
    const draft = insertBlueprintRevision(db, {
      projectId,
      parentId: approved.id,
      origin: 'creator',
      model: null,
      jobId: null,
      analysisId: approved.analysisId,
      sourceRevision: approved.sourceRevision,
      snapshot: getBlueprintSnapshot(db, approved.id),
      blueprint: approved.blueprint,
      branchId,
    });
    const copied = approveBlueprint(db, draft.id, draft.revision);

    const map = currentScreenMap(db, sourceBranch);
    if (map) {
      insertScreenMap(db, { projectId, branchId, blueprintRevisionId: copied.id, origin: 'branch', note: `Copied from “${src.name}” map ${map.number}`, mapping: map.mapping, expectedNumber: 0 });
    }
    const savedProfile = profile ? saveGradeProfile(db, { projectId, branchId, profile, origin: 'branch', expectedRevision: 0 }) : null;

    insertVersion(db, {
      projectId,
      config: {
        ...version.config,
        meta: {
          ...version.config.meta,
          blueprintRevisionId: copied.id,
          blueprintRevisionNumber: copied.number,
          gradeLabel: savedProfile ? gradeLabel(savedProfile.profile) : version.config.meta.gradeLabel,
          gradeProfileRevision: savedProfile?.revision ?? null,
        },
      },
      origin: 'branch',
      summary: `New grade version from “${src.name}” version ${version.number}`,
      blueprintRevisionId: copied.id,
      blueprintRevisionNumber: copied.number,
      parentVersionId: version.id,
      demo: version.demo,
      branchId,
    });
    setActiveBranch(db, projectId, branchId);
    insertMessage(db, {
      projectId,
      role: 'system',
      text: `Created the grade version “${name}” from “${src.name}” version ${version.number}. The earlier grade version is unchanged.${
        sourceProfile && savedProfile && gradeLabel(sourceProfile.profile) !== gradeLabel(savedProfile.profile)
          ? ` It still plays like ${gradeLabel(sourceProfile.profile)} until you review a grade adaptation plan for ${gradeLabel(savedProfile.profile)}.`
          : ''
      }`,
      scope: { kind: 'project', sceneId: null, slideId: null },
      area: 'general',
      origin: 'system',
    });
    return getBranch(db, branchId);
  });
}
