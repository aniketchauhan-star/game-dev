import type { Coverage } from '@shared/schemas/records.ts';
import { useRouter } from '../../../lib/router.tsx';
import { Banner, Pill } from '../../../components/ui/feedback.tsx';
import { Spinner } from '../../../components/ui/feedback.tsx';

const STATUS: Record<Coverage['slides'][number]['status'], { tone: 'success' | 'warning' | 'neutral'; label: string }> = {
  covered: { tone: 'success', label: 'Used' },
  'not-covered': { tone: 'warning', label: 'Not used' },
  excluded: { tone: 'neutral', label: 'Excluded' },
  hidden: { tone: 'neutral', label: 'Hidden' },
};

/** Which slides and concepts feed which scenes — exclusions and duplicates explained, never hidden. */
export function CoverageView({ coverage, projectId, loading }: { coverage: Coverage | undefined; projectId: string; loading: boolean }) {
  const { navigate } = useRouter();
  if (loading || !coverage) return <Spinner label="Computing coverage…" />;
  const sceneTitle = new Map(coverage.scenes.map((s, i) => [s.sceneId, `${i + 1}. ${s.title}`]));
  const s = coverage.summary;
  return (
    <div className="coverage stack">
      <header>
        <p className="eyebrow">Coverage</p>
        <h1>Slides → scenes</h1>
        <p className="muted">
          {coverage.blueprintRevisionId ? `${s.covered} of ${s.included} included slides are used by the latest blueprint.` : 'No blueprint yet — coverage appears once scenes exist.'} {s.excluded} slide(s) are excluded or hidden.
          {s.addedPracticeScenes ? ` ${s.addedPracticeScenes} scene(s) are added practice.` : ''}
        </p>
      </header>
      {coverage.duplicates.length > 0 && (
        <Banner tone="info" title="Slides used by more than one scene">
          {coverage.duplicates.map((d) => `Slide ${d.slideNumber} → ${d.sceneIds.map((id) => sceneTitle.get(id) ?? id).join(', ')}`).join(' · ')}
        </Banner>
      )}
      <div className="table-wrap panel">
        <table className="table coverage-table">
          <thead>
            <tr>
              <th scope="col">Slide</th>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">Scenes</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {coverage.slides.map((row) => (
              <tr key={row.slideId}>
                <td className="tabular">
                  <button type="button" className="link-btn" onClick={() => navigate(`/p/${projectId}/source?slide=${row.slideId}`)}>
                    {row.slideNumber}
                  </button>
                </td>
                <td>{row.title || <span className="subtle">(no title)</span>}</td>
                <td>
                  <Pill tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Pill>
                </td>
                <td>{row.sceneIds.map((id) => sceneTitle.get(id) ?? id).join(', ') || '—'}</td>
                <td className="subtle small">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {coverage.concepts.length > 0 && (
        <section className="panel panel-pad">
          <h2 className="h-sub">Concepts → scenes</h2>
          <ul className="concept-coverage">
            {coverage.concepts.map((c) => (
              <li key={c.conceptId}>
                <strong>{c.name}</strong>
                <span className={c.sceneIds.length ? 'muted small' : 'meta-warn small'}>{c.sceneIds.length ? c.sceneIds.map((id) => sceneTitle.get(id) ?? id).join(', ') : 'Not practised in any scene'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
