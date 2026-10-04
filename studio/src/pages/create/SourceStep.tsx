import type { ProjectDetail } from '@shared/schemas/project.ts';
import { SetupCards, useSourceSummary } from '../../components/setup/SetupCards.tsx';
import { Banner } from '../../components/ui/feedback.tsx';

/**
 * Step 1: bring the sources together. Any useful combination of a Figma
 * design, a PowerPoint lesson/storyboard and game assets is accepted, and the
 * grade is set before any blueprint is generated.
 */
export function SourceStep({ project }: { project: ProjectDetail }) {
  const summary = useSourceSummary(project);
  const nothing = !summary.loading && summary.slideCount === 0 && summary.frameCount === 0 && summary.assetCount === 0;
  return (
    <div className="create-step">
      <header className="create-step-head">
        <h1>Add your sources and choose the grade</h1>
        <p className="muted">Bring a Figma design, a PowerPoint lesson or storyboard, and artwork into one project — any combination works. PowerPoint supplies lesson content, Figma supplies layout and style, and your uploads supply exact artwork, unless you change those roles later in Screens.</p>
      </header>
      <SetupCards project={project} initial={summary.slideCount === 0 && !summary.loading ? 'lesson' : null} />
      {nothing && (
        <Banner tone="info" title="No lesson content yet">
          Without a deck or design, the next step asks for a brief and learning objectives. NEXUS does not invent a complete lesson to fill the gap.
        </Banner>
      )}
      {!summary.loading && !summary.grade && (
        <Banner tone="warning" title="Which grade is this game for?">
          Set the grade & learning profile before generating the blueprint — it seeds suggestions for difficulty, reading support, guidance and motion, which you can change.
        </Banner>
      )}
    </div>
  );
}
