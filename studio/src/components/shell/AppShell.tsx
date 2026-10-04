import { useEffect, useState, type ReactNode } from 'react';
import { Blocks, Clapperboard, Download, FileText, FolderKanban, Gamepad2, GitBranch, History, Image, LayoutTemplate, Play, Rocket, Settings, CloudOff, Check, LoaderCircle, Monitor } from 'lucide-react';
import { STAGES, stageForState, type ProjectDetail } from '@shared/schemas/project.ts';
import { Link, useRouter } from '../../lib/router.tsx';
import { useProject, useRenameProject, useRestoreVersion, useVersions } from '../../lib/queries.ts';
import { useSaveStatus } from '../../lib/saveStatus.tsx';
import { useTrackActiveJobs } from '../../lib/jobs.tsx';
import { formatDate } from '../../lib/format.ts';
import { OrbitalMark } from '../brand/OrbitalMark.tsx';
import { Button, IconButton, Tooltip } from '../ui/controls.tsx';
import { DemoBadge } from '../ui/feedback.tsx';
import { Menu, useToast } from '../ui/overlay.tsx';
import { errorMessage } from '../../lib/api.ts';
import { useActivateBranch } from '../../lib/studioQueries.ts';

export type Area = 'projects' | 'prepare' | 'source' | 'blueprint' | 'screens' | 'build' | 'animate' | 'assets' | 'settings' | 'export' | 'create';

const NAV: Array<{ area: Area; label: string; icon: ReactNode; project: boolean }> = [
  { area: 'projects', label: 'Projects', icon: <FolderKanban size={22} aria-hidden="true" />, project: false },
  { area: 'prepare', label: 'Prepare', icon: <Rocket size={22} aria-hidden="true" />, project: true },
  { area: 'source', label: 'Source', icon: <FileText size={22} aria-hidden="true" />, project: true },
  { area: 'blueprint', label: 'Blueprint', icon: <Blocks size={22} aria-hidden="true" />, project: true },
  { area: 'screens', label: 'Screens', icon: <LayoutTemplate size={22} aria-hidden="true" />, project: true },
  { area: 'build', label: 'Build', icon: <Gamepad2 size={22} aria-hidden="true" />, project: true },
  { area: 'animate', label: 'Animate', icon: <Clapperboard size={22} aria-hidden="true" />, project: true },
  { area: 'assets', label: 'Assets', icon: <Image size={22} aria-hidden="true" />, project: true },
];

function hrefFor(area: Area, projectId: string | null): string {
  if (area === 'projects') return '/';
  if (area === 'settings') return '/settings';
  return projectId ? `/p/${projectId}/${area}` : '/';
}

function NavRail({ area, projectId }: { area: Area; projectId: string | null }) {
  const current = area === 'create' ? 'prepare' : area === 'export' ? 'build' : area;
  const item = (n: { area: Area; label: string; icon: ReactNode; project: boolean }) => {
    const disabled = n.project && !projectId;
    const active = current === n.area;
    if (disabled) {
      return (
        <Tooltip key={n.area} label="Open a project first" side="right">
          <span className="rail-item is-disabled" aria-disabled="true" tabIndex={0}>
            {n.icon}
            <span className="rail-label">{n.label}</span>
          </span>
        </Tooltip>
      );
    }
    return (
      <Link key={n.area} to={hrefFor(n.area, projectId)} className={`rail-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
        {n.icon}
        <span className="rail-label">{n.label}</span>
      </Link>
    );
  };
  return (
    <nav className="rail" aria-label="Main">
      {NAV.map(item)}
      <div className="spacer" />
      {item({ area: 'settings', label: 'Settings', icon: <Settings size={22} aria-hidden="true" />, project: false })}
    </nav>
  );
}

function SaveIndicator({ project }: { project: ProjectDetail | null }) {
  const { state } = useSaveStatus();
  if (state.status === 'saving') {
    return (
      <span className="save-state" role="status">
        <LoaderCircle size={15} className="spin" aria-hidden="true" /> Saving…
      </span>
    );
  }
  if (state.status === 'error') {
    return (
      <span className="save-state is-error" role="alert">
        <CloudOff size={15} aria-hidden="true" /> Not saved
        {state.retry && (
          <button type="button" className="link-btn" onClick={state.retry}>
            Retry
          </button>
        )}
      </span>
    );
  }
  if (state.status === 'saved') {
    return (
      <span className="save-state is-saved" role="status" title={state.at ? `Saved at ${new Date(state.at).toLocaleTimeString()}` : undefined}>
        <Check size={15} aria-hidden="true" /> All changes saved
      </span>
    );
  }
  // Nothing written in this session yet: every edit is persisted on the server as it happens,
  // so the project's own last-write time is the honest answer.
  if (project) {
    return (
      <span className="save-state is-saved" role="status" title={`Last saved ${formatDate(project.updatedAt)}`}>
        <Check size={15} aria-hidden="true" /> Saved
      </span>
    );
  }
  return null;
}

function ProjectName({ project }: { project: ProjectDetail }) {
  const rename = useRenameProject();
  const { track } = useSaveStatus();
  const [value, setValue] = useState(project.name);
  useEffect(() => setValue(project.name), [project.name]);
  const commit = () => {
    const name = value.trim();
    if (!name || name === project.name) return setValue(project.name);
    void track(() => rename.mutateAsync({ id: project.id, name })).catch(() => setValue(project.name));
  };
  return (
    <input
      className="project-name"
      aria-label="Project name"
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setValue(project.name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function StageIndicator({ project }: { project: ProjectDetail }) {
  const stage = stageForState(project.state);
  const idx = STAGES.indexOf(stage);
  return (
    <div className="stage-indicator" aria-label={`Current stage: ${stage} (${idx + 1} of ${STAGES.length})`}>
      <ol aria-hidden="true">
        {STAGES.map((s, i) => (
          <li key={s} className={i < idx ? 'is-done' : i === idx ? 'is-now' : ''} title={s} />
        ))}
      </ol>
      <span className="stage-label">{stage}</span>
    </div>
  );
}

function VersionMenu({ project }: { project: ProjectDetail }) {
  const versions = useVersions(project.id);
  const restore = useRestoreVersion(project.id);
  const { navigate } = useRouter();
  const toast = useToast();
  const list = versions.data?.versions ?? [];
  const current = list.find((v) => v.id === versions.data?.currentVersionId);
  if (list.length === 0) {
    return (
      <span className="version-chip is-empty" title="No playable version yet">
        <History size={15} aria-hidden="true" /> No version yet
      </span>
    );
  }
  return (
    <Menu
      label="Game versions"
      trigger={(props) => (
        <button type="button" className="version-chip" {...props} aria-label={`Game version ${current?.number ?? ''}. Open version history`}>
          <History size={15} aria-hidden="true" /> v{current?.number ?? '—'}
        </button>
      )}
      items={list.slice(0, 12).flatMap((v, i) => {
        const isCurrent = v.id === current?.id;
        const items = [
          {
            label: `v${v.number}${isCurrent ? ' (current)' : ''} · ${v.summary.slice(0, 34)}${v.summary.length > 34 ? '…' : ''}`,
            onSelect: () => navigate(`/p/${project.id}/build${isCurrent ? '' : `?version=${v.id}`}`),
            separatorBefore: i > 0,
          },
        ];
        if (!isCurrent) {
          items.push({
            label: `Restore v${v.number} as a new version`,
            onSelect: () =>
              restore.mutate(v.id, {
                onSuccess: (nv) => toast({ tone: 'success', title: `Restored v${v.number} as v${nv.number}`, detail: 'Earlier versions are kept in the history.' }),
                onError: (e) => toast({ tone: 'error', title: 'Could not restore', detail: errorMessage(e).message }),
              }),
            separatorBefore: false,
          });
        }
        return items;
      })}
    />
  );
}

/** The grade version being edited, with switching and “Create another grade version”. */
function GradeVersionMenu({ project }: { project: ProjectDetail }) {
  const activate = useActivateBranch(project.id);
  const { navigate } = useRouter();
  const toast = useToast();
  const active = project.branches.find((b) => b.active);
  if (!active) return null;
  return (
    <Menu
      label="Grade versions"
      trigger={(props) => (
        <button type="button" className="branch-chip grade-chip-top" {...props} aria-label={`Grade version: ${active.name}${active.gradeLabel ? ` (${active.gradeLabel})` : ''}. Switch grade version`}>
          <GitBranch size={15} aria-hidden="true" /> {active.gradeLabel || active.name}
          {project.branches.length > 1 && <span className="subtle small"> · {project.branches.length} versions</span>}
        </button>
      )}
      items={[
        ...project.branches.map((b, i) => ({
          label: `${b.active ? '● ' : ''}${b.name}${b.gradeLabel ? ` — ${b.gradeLabel}` : ''}${b.currentVersionNumber ? ` · v${b.currentVersionNumber}` : ''}`,
          separatorBefore: i === 0 ? false : false,
          disabled: b.active,
          onSelect: () =>
            activate.mutate(b.id, {
              onSuccess: () => toast({ tone: 'success', title: `Now editing “${b.name}”`, detail: 'Versions, blueprint, screens, grade and motion follow the grade version.' }),
              onError: (e) => toast({ tone: 'error', title: 'Could not switch', detail: `${errorMessage(e).message} ${errorMessage(e).hint ?? ''}` }),
            }),
        })),
        { label: 'Create another grade version…', separatorBefore: true, onSelect: () => navigate(`/p/${project.id}/prepare?branch=new`) },
      ]}
    />
  );
}

function TopBar({ project, area }: { project: ProjectDetail | null; area: Area }) {
  const { navigate } = useRouter();
  return (
    <header className="topbar">
      <Link to="/" className="topbar-brand" aria-label="NEXUS Play Studio — projects">
        <OrbitalMark size={30} />
      </Link>
      <div className="topbar-title">
        {project ? (
          <>
            <ProjectName project={project} />
            {project.isSample && <DemoBadge text="Bundled sample" />}
          </>
        ) : (
          <span className="product-name">
            NEXUS <span>Play Studio</span>
          </span>
        )}
      </div>
      {project && <StageIndicator project={project} />}
      <div className="spacer" />
      <SaveIndicator project={project} />
      {project && (
        <>
          <GradeVersionMenu project={project} />
          <VersionMenu project={project} />
          <Tooltip label={project.currentVersionId ? 'Play the current version' : 'Build the game first'} side="bottom">
            <span>
              <Button icon={<Play size={16} aria-hidden="true" />} disabled={!project.currentVersionId} onClick={() => navigate(`/p/${project.id}/build?play=1`)}>
                Play
              </Button>
            </span>
          </Tooltip>
          <Button variant={area === 'export' ? 'primary' : 'default'} icon={<Download size={16} aria-hidden="true" />} onClick={() => navigate(`/p/${project.id}/export`)}>
            Export
          </Button>
        </>
      )}
    </header>
  );
}

function MobileNotice() {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem('nx-mobile-notice') === '1';
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  return (
    <div className="mobile-notice" role="note">
      <Monitor size={16} aria-hidden="true" />
      <span>Full authoring works best on a larger display. Here you can review projects, playtest games and make light edits.</span>
      <IconButton
        label="Dismiss"
        size="sm"
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem('nx-mobile-notice', '1');
          } catch {
            // storage unavailable — notice just reappears next visit
          }
        }}
      >
        ×
      </IconButton>
    </div>
  );
}

export function AppShell({ area, projectId, children }: { area: Area; projectId: string | null; children: ReactNode }) {
  const project = useProject(projectId);
  useTrackActiveJobs(project.data?.activeJobs);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <TopBar project={project.data ?? null} area={area} />
      <NavRail area={area} projectId={projectId} />
      <main id="main" className="app-main" tabIndex={-1}>
        <MobileNotice />
        {children}
      </main>
    </div>
  );
}

export function useAreaLink(projectId: string) {
  return (area: Area) => hrefFor(area, projectId);
}

export { formatDate };
