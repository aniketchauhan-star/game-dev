import { FileText, PlusCircle } from 'lucide-react';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { useRouter } from '../lib/router.tsx';

/** Chips that open the actual cited slide. Added practice is labelled as such — never as a slide. */
export function SourceChips({ projectId, slideIds, slides, addedPractice }: { projectId: string; slideIds: string[]; slides: SourceSlide[]; addedPractice?: boolean }) {
  const { navigate } = useRouter();
  const byId = new Map(slides.map((s) => [s.id, s]));
  if (addedPractice) {
    return (
      <span className="chip chip-added" title="Goes beyond the slides; marked as added practice">
        <PlusCircle size={12} aria-hidden="true" /> Added practice
      </span>
    );
  }
  if (slideIds.length === 0) return <span className="chip">No source</span>;
  return (
    <span className="chips" aria-label="Source slides">
      {slideIds.map((id) => {
        const s = byId.get(id);
        return (
          <button
            key={id}
            type="button"
            className="chip chip-source"
            title={s ? `Open slide ${s.slideNumber}: ${s.extract.title || 'untitled'}` : 'This slide is no longer in the deck'}
            disabled={!s}
            onClick={() => navigate(`/p/${projectId}/source?slide=${id}`)}
          >
            <FileText size={12} aria-hidden="true" />
            {s ? `Slide ${s.slideNumber}` : 'Missing slide'}
          </button>
        );
      })}
    </span>
  );
}
