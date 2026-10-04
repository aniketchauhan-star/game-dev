import { Sigma, Table2 } from 'lucide-react';
import { effectiveSlideText, type SourceSlide } from '@shared/schemas/source.ts';

/**
 * “Extracted content view”: the extracted text boxes, tables, equations and
 * images laid out at their recorded positions. It is explicitly NOT a
 * rendering of the slide — fonts, colours and graphics are not reproduced.
 */
export function ExtractedView({ slide, aspect }: { slide: SourceSlide; aspect: number }) {
  const text = effectiveSlideText(slide);
  const blockText = new Map(text.blocks.map((b) => [b.id, b.paragraphs]));
  const items = [
    ...slide.extract.blocks.map((b) => ({ kind: 'text' as const, id: b.id, bounds: b.bounds, role: b.role, order: b.order })),
    ...slide.extract.tables.map((t) => ({ kind: 'table' as const, id: t.id, bounds: t.bounds, role: 'table', order: t.order })),
    ...slide.extract.images.map((i) => ({ kind: 'image' as const, id: i.id, bounds: i.bounds, role: 'image', order: i.order })),
  ].filter((i) => i.bounds);
  const unplaced = slide.extract.blocks.length + slide.extract.tables.length + slide.extract.images.length - items.length;
  return (
    <figure className="extracted-view">
      <div className="extracted-frame" style={{ aspectRatio: `${aspect}` }}>
        {items.map((it) => {
          const b = it.bounds!;
          const style = { left: `${b.nx * 100}%`, top: `${b.ny * 100}%`, width: `${b.nw * 100}%`, height: `${b.nh * 100}%` };
          if (it.kind === 'image') {
            const img = slide.extract.images.find((x) => x.id === it.id)!;
            return (
              <div key={it.id} className="xv-box xv-image" style={style} title={img.altText || 'Image'}>
                {img.assetId ? <img src={`/api/assets/${img.assetId}/file?variant=thumb`} alt={img.altText || ''} /> : <span>{img.supported ? 'Image' : 'Unsupported image format'}</span>}
              </div>
            );
          }
          if (it.kind === 'table') {
            const t = slide.extract.tables.find((x) => x.id === it.id)!;
            return (
              <div key={it.id} className="xv-box xv-table" style={style}>
                <Table2 size={12} aria-hidden="true" /> Table · {t.rows.length}×{t.rows[0]?.length ?? 0}
              </div>
            );
          }
          const paras = blockText.get(it.id) ?? [];
          return (
            <div key={it.id} className={`xv-box xv-text xv-${it.role}`} style={style} title={`Reading order ${it.order + 1}`}>
              <span className="xv-order" aria-hidden="true">
                {it.order + 1}
              </span>
              {paras.slice(0, 6).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          );
        })}
        {slide.extract.equations.length > 0 && (
          <div className="xv-eq-note">
            <Sigma size={12} aria-hidden="true" /> {slide.extract.equations.length} equation(s)
          </div>
        )}
      </div>
      <figcaption className="subtle small">
        Extracted content view — positions from the deck; not a rendering of the slide.
        {unplaced > 0 && ` ${unplaced} item(s) without a recorded position are listed below.`}
      </figcaption>
    </figure>
  );
}
