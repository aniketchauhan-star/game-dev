import { useMemo, useState } from 'react';
import { Clapperboard, Copy, Ellipsis, FlaskConical, FolderOpen, Pencil, Plus, Presentation, Search, Trash2 } from 'lucide-react';
import type { ProjectSummary } from '@shared/schemas/project.ts';
import { useRouter } from '../lib/router.tsx';
import { useCreateProject, useCreateSample, useDeleteProject, useDuplicateProject, useProjects, useRenameProject } from '../lib/queries.ts';
import { errorMessage } from '../lib/api.ts';
import { formatDate, plural } from '../lib/format.ts';
import { Button, Field, TextInput } from '../components/ui/controls.tsx';
import { Banner, EmptyState, Skeleton, StatusPill } from '../components/ui/feedback.tsx';
import { ConfirmDialog, Dialog, Menu, useToast } from '../components/ui/overlay.tsx';
import { ThemeArt } from '../components/themes/ThemeArt.tsx';

function ProjectCard({ p, onRename, onDuplicate, onDelete }: { p: ProjectSummary; onRename: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const { navigate } = useRouter();
  const open = () => navigate(`/p/${p.id}/${p.statusLabel === 'Playable' ? 'build' : p.slideCount > 0 ? 'source' : 'create/source'}`);
  const meta = [p.subject, p.gradeOrAge].filter(Boolean).join(' · ');
  return (
    <article className="project-card">
      <button type="button" className="project-cover" onClick={open} aria-label={`Open ${p.name}`}>
        <ThemeArt themeId={p.themeId} paletteId={p.paletteId} />
        {p.isSample && <span className="cover-flag">Bundled sample</span>}
      </button>
      <div className="project-meta">
        <div className="project-meta-top">
          <h3 className="project-title">
            <button type="button" onClick={open} className="title-link">
              {p.name}
            </button>
          </h3>
          <Menu
            label={`Actions for ${p.name}`}
            trigger={(props) => (
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`More actions for ${p.name}`} {...props}>
                <Ellipsis size={18} aria-hidden="true" />
              </button>
            )}
            items={[
              { label: 'Open', icon: <FolderOpen size={16} aria-hidden="true" />, onSelect: open },
              { label: 'Rename', icon: <Pencil size={16} aria-hidden="true" />, onSelect: onRename },
              { label: 'Duplicate', icon: <Copy size={16} aria-hidden="true" />, onSelect: onDuplicate },
              { label: 'Delete…', icon: <Trash2 size={16} aria-hidden="true" />, onSelect: onDelete, danger: true, separatorBefore: true },
            ]}
          />
        </div>
        <p className="project-sub">{meta || <span className="subtle">No subject or grade yet</span>}</p>
        <div className="project-foot">
          <StatusPill label={p.statusLabel} />
          <span className="subtle small">Edited {formatDate(p.updatedAt)}</span>
        </div>
        {p.statusDetail && <p className="project-detail small">{p.statusDetail}</p>}
      </div>
    </article>
  );
}

export function DashboardPage() {
  const { navigate } = useRouter();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const projects = useProjects(search);
  const create = useCreateProject();
  const sample = useCreateSample();
  const trapezium = useCreateSample();
  const rename = useRenameProject();
  const duplicate = useDuplicateProject();
  const del = useDeleteProject();
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const list = projects.data ?? [];
  const isEmptyInstall = !projects.isLoading && list.length === 0 && search.trim() === '';
  const counts = useMemo(() => list.length, [list]);

  const startCreate = () =>
    create.mutate('Untitled game', {
      onSuccess: (p) => navigate(`/p/${p.id}/create/source`),
      onError: (e) => toast({ tone: 'error', title: 'Could not create a project', detail: errorMessage(e).message }),
    });
  const startSample = () =>
    sample.mutate('air-traffic', {
      onSuccess: (p) => navigate(`/p/${p.id}/build`),
      onError: (e) => toast({ tone: 'error', title: 'Could not open the sample', detail: errorMessage(e).message }),
    });
  // The Grade 8 starter has a brief and grade profile only; its lesson, screens and artwork are added in Prepare.
  const startTrapezium = () =>
    trapezium.mutate('trapezium', {
      onSuccess: (p) => navigate(`/p/${p.id}/prepare`),
      onError: (e) => toast({ tone: 'error', title: 'Could not open the sample', detail: errorMessage(e).message }),
    });

  return (
    <div className="dashboard grid-texture">
      <div className="dashboard-inner">
        <header className="dashboard-head">
          <div>
            <p className="eyebrow">NEXUS Play Studio</p>
            <h1>Projects</h1>
            <p className="muted">From slides to playable learning.</p>
          </div>
          <div className="dashboard-actions">
            <Button variant="default" size="lg" icon={<FlaskConical size={18} aria-hidden="true" />} loading={sample.isPending} onClick={startSample}>
              Try sample project
            </Button>
            <Button variant="default" size="lg" icon={<Clapperboard size={18} aria-hidden="true" />} loading={trapezium.isPending} onClick={startTrapezium} title="Grade 8 trapezium starter: add the bundled lesson, exported screens and artwork, then map screens and add motion.">
              Grade 8 design sample
            </Button>
            <Button variant="primary" size="lg" icon={<Plus size={18} aria-hidden="true" />} loading={create.isPending} onClick={startCreate}>
              Create game
            </Button>
          </div>
        </header>

        {projects.isError && (
          <Banner tone="danger" title="Projects could not be loaded" actions={<Button size="sm" onClick={() => projects.refetch()}>Retry</Button>}>
            {errorMessage(projects.error).message}
          </Banner>
        )}

        {isEmptyInstall ? (
          <div className="dashboard-empty panel">
            <EmptyState
              icon={<Presentation size={26} aria-hidden="true" />}
              title="Turn a lesson deck into a game"
              actions={
                <>
                  <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} loading={create.isPending} onClick={startCreate}>
                    Create game from a .pptx
                  </Button>
                  <Button icon={<FlaskConical size={16} aria-hidden="true" />} loading={sample.isPending} onClick={startSample}>
                    Try sample project
                  </Button>
                  <Button icon={<Clapperboard size={16} aria-hidden="true" />} loading={trapezium.isPending} onClick={startTrapezium}>
                    Grade 8 design sample
                  </Button>
                </>
              }
            >
              Import a PowerPoint deck, describe what learners should do, review Claude’s blueprint and build a playable game. The sample “Air Traffic Control — Coordinate Mission” uses bundled example content; the Grade 8 design sample walks through design screens, artwork and motion with a trapezium lesson.
            </EmptyState>
            <ol className="journey" aria-label="How it works">
              {['Import deck', 'Review content', 'Describe game', 'Approve blueprint', 'Build & playtest', 'Refine', 'Export'].map((s, i) => (
                <li key={s}>
                  <span className="journey-num">{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <>
            <div className="dashboard-toolbar">
              <div className="search">
                <Search size={16} aria-hidden="true" />
                <TextInput type="search" placeholder="Search by name, subject or grade" aria-label="Search projects" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <span className="subtle small" aria-live="polite">
                {projects.isLoading ? 'Loading…' : plural(counts, 'project')}
              </span>
            </div>
            {projects.isLoading ? (
              <div className="project-grid">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="project-card">
                    <Skeleton height={170} />
                    <div className="project-meta">
                      <Skeleton width="70%" />
                      <Skeleton width="40%" />
                    </div>
                  </div>
                ))}
              </div>
            ) : list.length === 0 ? (
              <EmptyState icon={<Search size={24} aria-hidden="true" />} title="No matching projects">
                Nothing matches “{search}”. Try another name, subject or grade.
              </EmptyState>
            ) : (
              <div className="project-grid">
                {list.map((p) => (
                  <ProjectCard
                    key={p.id}
                    p={p}
                    onRename={() => {
                      setRenaming(p);
                      setRenameValue(p.name);
                    }}
                    onDuplicate={() =>
                      duplicate.mutate(p.id, {
                        onSuccess: (d) => toast({ tone: 'success', title: `Duplicated as “${d.name}”`, detail: 'The copy has its own versions and asset files.' }),
                        onError: (e) => toast({ tone: 'error', title: 'Could not duplicate', detail: errorMessage(e).message }),
                      })
                    }
                    onDelete={() => {
                      setDeleting(p);
                      setConfirmText('');
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <Dialog
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="Rename project"
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={rename.isPending}
              disabled={!renameValue.trim()}
              onClick={() =>
                renaming &&
                rename.mutate(
                  { id: renaming.id, name: renameValue.trim() },
                  {
                    onSuccess: () => setRenaming(null),
                    onError: (e) => toast({ tone: 'error', title: 'Could not rename', detail: errorMessage(e).message }),
                  },
                )
              }
            >
              Save name
            </Button>
          </>
        }
      >
        <Field label="Project name" htmlFor="rename-input">
          <TextInput id="rename-input" value={renameValue} maxLength={120} autoFocus onChange={(e) => setRenameValue(e.target.value)} />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete project?"
        confirmLabel="Delete project"
        danger
        busy={del.isPending}
        confirmDisabled={confirmText.trim() !== deleting?.name.trim()}
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          deleting &&
          del.mutate(
            { id: deleting.id, confirmName: confirmText },
            {
              onSuccess: () => {
                toast({ tone: 'success', title: `Deleted “${deleting.name}”` });
                setDeleting(null);
              },
              onError: (e) => toast({ tone: 'error', title: 'Could not delete', detail: errorMessage(e).message }),
            },
          )
        }
      >
        <p>
          This permanently deletes <strong>{deleting?.name}</strong>, its uploaded deck, assets, blueprints, game versions and exports. Duplicates of this project are not affected.
        </p>
        <Field label={`Type the project name to confirm`} htmlFor="delete-confirm">
          <TextInput id="delete-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
