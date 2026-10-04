import { useEffect, type ReactNode } from 'react';
import { createStepSchema } from '@shared/schemas/project.ts';
import { matchPath, useRouter } from './lib/router.tsx';
import { useProject } from './lib/queries.ts';
import { AppShell, type Area } from './components/shell/AppShell.tsx';
import { Spinner } from './components/ui/feedback.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { CreatePage } from './pages/create/CreatePage.tsx';
import { SourceArea } from './pages/workspace/source/SourceArea.tsx';
import { BlueprintArea } from './pages/workspace/blueprint/BlueprintArea.tsx';
import { BuildArea } from './pages/workspace/build/BuildArea.tsx';
import { AssetsArea } from './pages/workspace/assets/AssetsArea.tsx';
import { ExportPage } from './pages/workspace/export/ExportPage.tsx';
import { PreparePage } from './pages/workspace/prepare/PreparePage.tsx';
import { ScreensArea } from './pages/workspace/screens/ScreensArea.tsx';
import { AnimateArea } from './pages/workspace/animate/AnimateArea.tsx';
import { EmptyState } from './components/ui/feedback.tsx';
import { Button } from './components/ui/controls.tsx';
import { Compass } from 'lucide-react';

const TITLES: Record<string, string> = {
  projects: 'Projects',
  prepare: 'Prepare',
  screens: 'Screens',
  animate: 'Animate',
  settings: 'Settings',
  source: 'Source review',
  blueprint: 'Blueprint',
  build: 'Build & playtest',
  assets: 'Assets',
  export: 'Export',
  create: 'Create game',
};

/** Send `/p/:id` to the most useful area for the project's state. */
function ProjectRedirect({ id }: { id: string }) {
  const { navigate } = useRouter();
  const project = useProject(id);
  useEffect(() => {
    if (!project.data) return;
    const p = project.data;
    const to = p.currentVersionId ? 'build' : p.latestBlueprintId ? 'blueprint' : p.slideCount > 0 ? 'source' : `create/${p.createStep}`;
    navigate(`/p/${id}/${to}`, { replace: true });
  }, [project.data, id, navigate]);
  return (
    <div className="center-fill">
      <Spinner large label="Opening project…" />
    </div>
  );
}

function NotFound() {
  const { navigate } = useRouter();
  return (
    <div className="center-fill">
      <EmptyState icon={<Compass size={24} aria-hidden="true" />} title="Page not found" actions={<Button onClick={() => navigate('/')}>Back to projects</Button>}>
        This address does not match anything in the studio.
      </EmptyState>
    </div>
  );
}

export function App() {
  const { path } = useRouter();
  let area: Area = 'projects';
  let projectId: string | null = null;
  let content: ReactNode;

  const create = matchPath('/p/:id/create/:step', path);
  const workspace = matchPath('/p/:id/:area', path);
  const projectRoot = matchPath('/p/:id', path);
  if (path === '/' || path === '') {
    content = <DashboardPage />;
  } else if (path === '/settings') {
    area = 'settings';
    content = <SettingsPage />;
  } else if (create) {
    projectId = create.id!;
    area = 'create';
    const step = createStepSchema.safeParse(create.step);
    content = step.success ? <CreatePage projectId={projectId} step={step.data} /> : <NotFound />;
  } else if (workspace && ['prepare', 'source', 'blueprint', 'screens', 'build', 'animate', 'assets', 'export'].includes(workspace.area!)) {
    projectId = workspace.id!;
    area = workspace.area as Area;
    const props = { projectId };
    content =
      area === 'prepare' ? (
        <PreparePage {...props} />
      ) : area === 'source' ? (
        <SourceArea {...props} />
      ) : area === 'blueprint' ? (
        <BlueprintArea {...props} />
      ) : area === 'screens' ? (
        <ScreensArea {...props} />
      ) : area === 'build' ? (
        <BuildArea {...props} />
      ) : area === 'animate' ? (
        <AnimateArea {...props} />
      ) : area === 'assets' ? (
        <AssetsArea {...props} />
      ) : (
        <ExportPage {...props} />
      );
  } else if (projectRoot) {
    projectId = projectRoot.id!;
    content = <ProjectRedirect id={projectId} />;
  } else {
    content = <NotFound />;
  }

  useEffect(() => {
    document.title = `${TITLES[area] ?? 'NEXUS'} · NEXUS Play Studio`;
  }, [area]);

  return (
    <AppShell area={area} projectId={projectId} key={projectId ?? 'none'}>
      {content}
    </AppShell>
  );
}
