import { useMemo, useState } from 'react';
import { CircleCheck, EyeOff, MessageSquareText, Search, TriangleAlert } from 'lucide-react';
import { effectiveSlideText, type SourceSlide } from '@shared/schemas/source.ts';
import { TextInput } from '../../../components/ui/controls.tsx';

type Filter = 'all' | 'review' | 'warnings' | 'excluded';

export function SlideList({ slides, selectedId, onSelect }: { slides: SourceSlide[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return slides.filter((s) => {
      if (filter === 'review' && s.reviewStatus === 'verified') return false;
      if (filter === 'warnings' && !s.extract.warnings.some((w) => w.severity === 'warning')) return false;
      if (filter === 'excluded' && s.included) return false;
      if (!needle) return true;
      const t = effectiveSlideText(s);
      return [t.title, ...t.blocks.flatMap((b) => b.paragraphs), ...t.notes].join(' ').toLowerCase().includes(needle);
    });
  }, [slides, q, filter]);
  const counts = {
    review: slides.filter((s) => s.reviewStatus !== 'verified').length,
    warnings: slides.filter((s) => s.extract.warnings.some((w) => w.severity === 'warning')).length,
    excluded: slides.filter((s) => !s.included).length,
  };
  return (
    <div className="slide-list">
      <div className="panel-head">
        <h2>Slides</h2>
        <span className="subtle small">
          {slides.filter((s) => s.included).length}/{slides.length} included
        </span>
      </div>
      <div className="list-tools">
        <div className="search">
          <Search size={15} aria-hidden="true" />
          <TextInput compact type="search" placeholder="Search slides" aria-label="Search slides and notes" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="filter-chips" role="group" aria-label="Filter slides">
          {(
            [
              ['all', `All ${slides.length}`],
              ['review', `To review ${counts.review}`],
              ['warnings', `Warnings ${counts.warnings}`],
              ['excluded', `Excluded ${counts.excluded}`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <ol className="slide-items" aria-label="Slides in presentation order">
        {visible.map((s) => {
          const t = effectiveSlideText(s);
          const warn = s.extract.warnings.filter((w) => w.severity === 'warning').length;
          const selected = s.id === selectedId;
          return (
            <li key={s.id}>
              <button type="button" className={`slide-item${selected ? ' is-selected' : ''}${s.included ? '' : ' is-excluded'}`} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(s.id)}>
                <span className="slide-num tabular">{s.slideNumber}</span>
                <span className="slide-item-main">
                  <span className="slide-item-title">{t.title || <span className="subtle">Untitled slide</span>}</span>
                  <span className="slide-item-meta">
                    {s.reviewStatus === 'verified' ? (
                      <span className="meta-ok">
                        <CircleCheck size={12} aria-hidden="true" /> Verified
                      </span>
                    ) : s.reviewStatus === 'missing_visual' ? (
                      <span className="meta-warn">Missing visual</span>
                    ) : (
                      <span className="subtle">Needs review</span>
                    )}
                    {s.hidden && (
                      <span title="Hidden in the deck">
                        <EyeOff size={12} aria-label="Hidden" />
                      </span>
                    )}
                    {t.notes.length > 0 && (
                      <span title="Has speaker notes">
                        <MessageSquareText size={12} aria-label="Has notes" />
                      </span>
                    )}
                    {warn > 0 && (
                      <span className="meta-warn" title={`${warn} warning(s)`}>
                        <TriangleAlert size={12} aria-hidden="true" /> {warn}
                      </span>
                    )}
                    {!s.included && <span className="subtle">Excluded</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {visible.length === 0 && <li className="subtle small pad">No slides match.</li>}
      </ol>
    </div>
  );
}
