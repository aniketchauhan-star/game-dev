import { Image as ImageIcon, Monitor } from 'lucide-react';
import type { GameBrief, ThemeId } from '@shared/schemas/brief.ts';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import type { AssetLibraryRole } from '@shared/schemas/assets.ts';
import { THEME_PRESETS } from '@shared/themes.ts';
import { useAssets } from '../../lib/queries.ts';
import { Field, Switch, TextArea } from '../../components/ui/controls.tsx';
import { ThemeArt } from '../../components/themes/ThemeArt.tsx';
import { AssetUploader } from '../../components/assets/AssetUploader.tsx';

const THEME_ORDER: ThemeId[] = ['ice', 'airport', 'space', 'city', 'custom'];

const UPLOAD_ROLES: Array<{ role: AssetLibraryRole; label: string; action: string; audio?: boolean; help: string }> = [
  { role: 'unassigned', label: 'Reference images', action: 'Add reference images', help: 'Mood boards or examples of the look you want.' },
  { role: 'background', label: 'Backgrounds', action: 'Add backgrounds', help: 'Shown behind scenes (16:9 works best).' },
  { role: 'character', label: 'Characters', action: 'Add characters', help: 'The mover or guide — transparent PNG is ideal.' },
  { role: 'ui', label: 'Buttons & UI', action: 'Add UI artwork', help: 'Optional custom UI artwork.' },
  { role: 'audio', label: 'Audio', action: 'Add audio', audio: true, help: 'Background music or sounds (MP3, OGG, WAV, M4A).' },
];

export function VisualStep({ project, brief, update }: { project: ProjectDetail; brief: GameBrief; update: (fn: (b: GameBrief) => GameBrief) => void }) {
  const assets = useAssets(project.id);
  const setVisual = <K extends keyof GameBrief['visual']>(key: K, value: GameBrief['visual'][K]) => update((b) => ({ ...b, visual: { ...b.visual, [key]: value } }));
  const setOption = <K extends keyof GameBrief['options']>(key: K, value: boolean) => update((b) => ({ ...b, options: { ...b.options, [key]: value } }));
  const preset = THEME_PRESETS[brief.visual.themeId];
  const byRole = (role: AssetLibraryRole) => (assets.data ?? []).filter((a) => a.role === role && a.source === 'uploaded');

  return (
    <div className="create-step">
      <header className="create-step-head">
        <h1>Visual direction</h1>
        <p className="muted">The game gets its own look — independent of this studio’s dark interface. Every palette is checked for readable contrast.</p>
      </header>

      <section aria-labelledby="theme-title" className="stack">
        <h2 id="theme-title" className="h-sub">
          Theme
        </h2>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEME_ORDER.map((id) => {
            const t = THEME_PRESETS[id];
            const selected = brief.visual.themeId === id;
            return (
              <label key={id} className={`theme-card${selected ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="theme"
                  className="sr-only"
                  checked={selected}
                  onChange={() => update((b) => ({ ...b, visual: { ...b.visual, themeId: id, paletteId: t.palettes[0]!.id } }))}
                />
                <div className="theme-card-art">
                  <ThemeArt themeId={id} paletteId={selected ? brief.visual.paletteId : t.palettes[0]!.id} />
                </div>
                <span className="theme-card-name">{t.label}</span>
                <span className="theme-card-desc">{t.description}</span>
              </label>
            );
          })}
        </div>
        <div className="palette-row" role="radiogroup" aria-label={`${preset.label} palettes`}>
          {preset.palettes.map((pal) => (
            <label key={pal.id} className={`palette-option${brief.visual.paletteId === pal.id ? ' is-selected' : ''}`}>
              <input type="radio" name="palette" className="sr-only" checked={brief.visual.paletteId === pal.id} onChange={() => setVisual('paletteId', pal.id)} />
              <span className="swatches" aria-hidden="true">
                {(['background', 'surface', 'primary', 'accent', 'text'] as const).map((k) => (
                  <span key={k} style={{ background: pal.palette[k] }} />
                ))}
              </span>
              {pal.label}
            </label>
          ))}
        </div>
        {brief.visual.themeId === 'custom' && (
          <Field label="Describe your reference look" htmlFor="custom-ref" help="Upload reference images below; the theme stays neutral until you add backgrounds and characters.">
            <TextArea id="custom-ref" rows={2} maxLength={400} value={brief.visual.customReferenceNote} onChange={(e) => setVisual('customReferenceNote', e.target.value)} />
          </Field>
        )}
      </section>

      <section aria-labelledby="assets-title" className="stack">
        <h2 id="assets-title" className="h-sub">
          Your artwork and audio <span className="subtle small">(optional)</span>
        </h2>
        <div className="upload-grid">
          {UPLOAD_ROLES.map((r) => {
            const list = byRole(r.role);
            return (
              <div key={r.role} className="upload-slot panel-raised">
                <div className="row">
                  <ImageIcon size={16} aria-hidden="true" />
                  <strong>{r.label}</strong>
                  <span className="spacer" />
                  <span className="subtle small">{list.length}</span>
                </div>
                <p className="subtle small">{r.help}</p>
                {list.length > 0 && (
                  <div className="thumb-row">
                    {list.slice(0, 4).map((a) =>
                      a.kind === 'image' ? (
                        <img key={a.id} src={`/api/assets/${a.id}/file?variant=thumb`} alt={a.metadata.alt || a.name} className="thumb checker" />
                      ) : (
                        <span key={a.id} className="thumb thumb-audio">
                          ♪
                        </span>
                      ),
                    )}
                  </div>
                )}
                <AssetUploader projectId={project.id} role={r.role} label={r.action} audio={r.audio} compact />
              </div>
            );
          })}
        </div>
        <p className="subtle small">Images from the deck are imported automatically and listed in the Asset library. Uploaded SVGs are rasterized — their markup is never shown in the studio or games.</p>
      </section>

      <section aria-labelledby="options-title" className="stack">
        <h2 id="options-title" className="h-sub">
          Options
        </h2>
        <div className="options-grid panel panel-pad">
          <Switch label="Minimal text" hint="Short instructions; progress shown as dots." checked={brief.options.minimalText} onChange={(v) => setOption('minimalText', v)} />
          <Switch label="Preserve source sequence" hint="Scenes follow the deck order; reordering is locked." checked={brief.options.preserveSequence} onChange={(v) => setOption('preserveSequence', v)} />
          <Switch label="Reuse supplied artwork" hint="Your characters are never swapped without approval." checked={brief.options.reuseArtwork} onChange={(v) => setOption('reuseArtwork', v)} />
          <Switch label="Allow added practice" hint="Scenes beyond the slides, clearly marked as added practice." checked={brief.options.allowAddedPractice} onChange={(v) => setOption('allowAddedPractice', v)} />
          <Switch label="Reduced motion" hint="No animated transitions for learners (also follows device settings)." checked={brief.options.reducedMotion} onChange={(v) => setOption('reducedMotion', v)} />
        </div>
        <p className="stage-note">
          <Monitor size={16} aria-hidden="true" /> Game stage: 16:9, 1920×1080 logical size. It scales to any screen without stretching or cropping.
        </p>
      </section>
    </div>
  );
}
