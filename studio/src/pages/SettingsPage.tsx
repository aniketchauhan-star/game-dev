import { useState, type ReactNode } from 'react';
import { Blocks, CircleAlert, CircleCheck, CircleHelp, Cpu, FileText, Frame, KeyRound, RefreshCw, Server, Sparkles } from 'lucide-react';
import { useClaudeSettings, useHealth, useModels, useUsage } from '../lib/queries.ts';
import { errorMessage } from '../lib/api.ts';
import { formatBytes, formatDate, formatTokens } from '../lib/format.ts';
import { Button, Select } from '../components/ui/controls.tsx';
import { Banner, Pill, Spinner } from '../components/ui/feedback.tsx';
import { useToast } from '../components/ui/overlay.tsx';

function StatusLine({ ok, warn, children }: { ok: boolean; warn?: boolean; children: ReactNode }) {
  return (
    <p className={`status-line ${ok ? 'is-ok' : warn ? 'is-warn' : 'is-bad'}`}>
      {ok ? <CircleCheck size={18} aria-hidden="true" /> : warn ? <CircleHelp size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
      <span>{children}</span>
    </p>
  );
}

export function SettingsPage() {
  const health = useHealth();
  const { test, chooseModel, checkRenderer, testFigma } = useClaudeSettings();
  const usage = useUsage();
  const toast = useToast();
  const h = health.data;
  const claude = h?.claude;
  const [pickModels, setPickModels] = useState(false);
  const models = useModels(pickModels && Boolean(claude?.keyPresent));
  const [model, setModel] = useState('');

  if (!h || !claude) {
    return (
      <div className="center-fill">
        <Spinner large label="Loading settings…" />
      </div>
    );
  }
  const label = { configured: 'Configured', unverified: 'Configured — not verified yet', not_configured: 'Not configured', connection_failed: 'Connection failed' }[claude.state];

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <header>
          <p className="eyebrow">Settings</p>
          <h1>Studio settings</h1>
          <p className="muted">This is a local, single-creator studio. Secrets stay in the server environment and are never shown here.</p>
        </header>

        <section className="panel panel-pad stack" aria-labelledby="set-claude">
          <div className="section-head">
            <h2 id="set-claude" className="h-sub">
              <Sparkles size={18} aria-hidden="true" /> Claude connection
            </h2>
            <Pill tone={claude.state === 'configured' ? 'success' : claude.state === 'connection_failed' ? 'danger' : 'warning'}>{label}</Pill>
          </div>
          <StatusLine ok={claude.keyPresent}>
            {claude.keyPresent ? 'An API key is present in the server environment (not displayed).' : 'No ANTHROPIC_API_KEY in the server environment.'}
          </StatusLine>
          <StatusLine ok={Boolean(claude.model)} warn={!claude.model}>
            Model: <strong>{claude.model ?? 'none selected'}</strong>
            {claude.modelSource === 'env' ? ' (from CLAUDE_MODEL)' : claude.modelSource === 'settings' ? ' (chosen here)' : ''}
          </StatusLine>
          {claude.modelInfo && (
            <dl className="kv">
              <dt>Verified model</dt>
              <dd>
                {claude.modelInfo.displayName} <span className="subtle mono">({claude.modelInfo.id})</span>
              </dd>
              <dt>Context window</dt>
              <dd className="tabular">{claude.modelInfo.maxInputTokens ? `${formatTokens(claude.modelInfo.maxInputTokens)} tokens` : '—'}</dd>
              <dt>Max output</dt>
              <dd className="tabular">{claude.modelInfo.maxOutputTokens ? `${formatTokens(claude.modelInfo.maxOutputTokens)} tokens` : '—'}</dd>
              <dt>Capabilities</dt>
              <dd>
                Structured outputs {claude.modelInfo.structuredOutputs ? 'yes' : 'no'} · images {claude.modelInfo.imageInput ? 'yes' : 'no'} · PDF pages {claude.modelInfo.pdfInput ? 'yes' : 'no'} · effort {claude.modelInfo.effort ? 'yes' : 'no'}
              </dd>
              <dt>Verified</dt>
              <dd>{claude.verifiedAt ? formatDate(claude.verifiedAt) : '—'}</dd>
              <dt>Refusal fallback</dt>
              <dd>{claude.refusalFallback === 'default' ? 'Server-side fallback enabled for supported models (CLAUDE_REFUSAL_FALLBACK=default)' : 'Off'}</dd>
            </dl>
          )}
          {claude.lastError && (
            <Banner tone="danger" title="Last check failed">
              {claude.lastError}
            </Banner>
          )}
          {claude.keyPresent ? (
            <div className="row-wrap">
              <Button
                icon={<RefreshCw size={16} aria-hidden="true" />}
                loading={test.isPending && test.variables === false}
                disabled={!claude.model}
                onClick={() => test.mutate(false, { onSuccess: (s) => toast({ tone: s.state === 'configured' ? 'success' : 'error', title: s.state === 'configured' ? 'Model verified' : 'Verification failed', detail: s.lastError }) })}
              >
                Test connection
              </Button>
              <Button
                variant="ghost"
                loading={test.isPending && test.variables === true}
                disabled={!claude.model}
                onClick={() => test.mutate(true, { onSuccess: (s) => toast({ tone: s.state === 'configured' ? 'success' : 'error', title: s.state === 'configured' ? 'Test request succeeded' : 'Test request failed', detail: s.lastError }) })}
              >
                Send a tiny test request
              </Button>
              {claude.modelSource !== 'env' && (
                <Button variant="ghost" onClick={() => setPickModels(true)}>
                  Choose a model
                </Button>
              )}
            </div>
          ) : null}
          <p className="subtle small">“Test connection” checks the model with the Models API (no generation). “Send a tiny test request” makes one small structured request, which uses a few tokens.</p>
          {pickModels && (
            <div className="row-wrap">
              {models.isLoading ? (
                <Spinner label="Loading available models…" />
              ) : models.isError ? (
                <Banner tone="danger" title="Models could not be listed">
                  {errorMessage(models.error).message}
                </Banner>
              ) : (
                <>
                  <Select aria-label="Available models" value={model} onChange={(e) => setModel(e.target.value)} style={{ width: 'auto' }}>
                    <option value="">Choose a model…</option>
                    {(models.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName} ({m.id})
                      </option>
                    ))}
                  </Select>
                  <Button variant="primary" disabled={!model} loading={chooseModel.isPending} onClick={() => chooseModel.mutate(model, { onError: (e) => toast({ tone: 'error', title: 'Not saved', detail: errorMessage(e).message }) })}>
                    Use and verify
                  </Button>
                </>
              )}
            </div>
          )}
          {!claude.keyPresent && (
            <div className="setup-steps">
              <h3 className="h-sub-sm">
                <KeyRound size={15} aria-hidden="true" /> Set up Claude
              </h3>
              <ol>
                <li>
                  Copy <code>.env.example</code> to <code>.env</code> in the project folder.
                </li>
                <li>
                  Set <code>ANTHROPIC_API_KEY=…</code> (from the Claude Console) and optionally <code>CLAUDE_MODEL=claude-opus-5-5</code>.
                </li>
                <li>
                  Restart <code>npm run dev</code>, then return here and choose “Test connection”.
                </li>
              </ol>
              <p className="subtle small">The key is read only by the server process. It is never sent to the browser, stored in the database, written to logs, passed to the game preview, or included in exports. Without a key, the studio still imports and reviews decks, lets you author blueprints, and plays the bundled sample in demo mode.</p>
            </div>
          )}
        </section>

        <section className="panel panel-pad stack" aria-labelledby="set-figma">
          <div className="section-head">
            <h2 id="set-figma" className="h-sub">
              <Frame size={18} aria-hidden="true" /> Figma (read-only)
            </h2>
            <Pill tone={h.figma.state === 'verified' ? 'success' : h.figma.state === 'error' ? 'danger' : h.figma.state === 'configured' ? 'info' : 'neutral'}>
              {{ 'not-configured': 'Not configured', configured: 'Configured — not checked', verified: 'Connected', error: 'Check failed' }[h.figma.state]}
            </Pill>
          </div>
          <StatusLine ok={h.figma.tokenPresent} warn={!h.figma.tokenPresent}>
            {h.figma.tokenPresent ? 'A personal access token is present in the server environment (never displayed, sent to the browser, logged, exported or included in Claude prompts).' : 'No FIGMA_ACCESS_TOKEN in the server environment.'}
          </StatusLine>
          <StatusLine ok={h.figma.state === 'verified'} warn={h.figma.state !== 'error'}>
            {h.figma.detail}
            {h.figma.checkedAt ? <span className="subtle"> · checked {formatDate(h.figma.checkedAt)}</span> : null}
          </StatusLine>
          <StatusLine ok={false} warn>
            Sign in with Figma (OAuth): not configured. Hosted multi-user sign-in needs its own integration; this local build reads files with the server's token only.
          </StatusLine>
          {h.figma.tokenPresent && (
            <div className="row-wrap">
              <Button
                icon={<RefreshCw size={16} aria-hidden="true" />}
                loading={testFigma.isPending}
                onClick={() =>
                  testFigma.mutate(undefined, {
                    onSuccess: (f) => toast({ tone: f.state === 'error' ? 'error' : 'success', title: f.state === 'error' ? 'Figma check failed' : 'Figma checked', detail: f.detail }),
                    onError: (e) => toast({ tone: 'error', title: 'Figma check failed', detail: errorMessage(e).message }),
                  })
                }
              >
                Test connection
              </Button>
            </div>
          )}
          <p className="subtle small">
            Set <code>FIGMA_ACCESS_TOKEN</code> in the server's <code>.env</code> (a personal access token with the <code>file_content:read</code> scope; <code>current_user:read</code> lets this page show the account). The studio never inherits a Figma connection from ChatGPT, Claude or an editor plugin, and never writes to Figma. Without a token you can still upload exported PNG, JPEG, SVG or PDF screens.
          </p>
        </section>

        <section className="panel panel-pad stack" aria-labelledby="set-render">
          <div className="section-head">
            <h2 id="set-render" className="h-sub">
              <FileText size={18} aria-hidden="true" /> Slide rendering
            </h2>
            <Pill tone={h.renderer.state === 'available' ? 'success' : 'neutral'}>{h.renderer.state}</Pill>
          </div>
          <StatusLine ok={h.renderer.state === 'available'} warn={h.renderer.state !== 'error'}>
            {h.renderer.detail}
            {h.renderer.version ? ` (${h.renderer.version})` : ''}
          </StatusLine>
          <div className="row-wrap">
            <Button icon={<RefreshCw size={16} aria-hidden="true" />} loading={checkRenderer.isPending} onClick={() => checkRenderer.mutate()}>
              Check again
            </Button>
          </div>
          <p className="subtle small">
            Optional. With LibreOffice installed (or <code>SOFFICE_PATH</code> set, or <code>RENDERER=docker</code> with an image), decks can be rendered to PDF pages for visual reference. Without it, slides are shown as an Extracted content view — never a fake screenshot — and you can add your own PDF export.
          </p>
        </section>

        <section className="panel panel-pad stack" aria-labelledby="set-worker">
          <h2 id="set-worker" className="h-sub">
            <Server size={18} aria-hidden="true" /> Background worker
          </h2>
          <StatusLine ok={h.worker.online}>
            {h.worker.online ? `Running (last heartbeat ${h.worker.lastHeartbeat ? formatDate(h.worker.lastHeartbeat) : '—'}).` : 'Offline — imports, analysis and builds wait in the queue until it runs. Start it with npm run dev (or npm run dev:worker).'}
          </StatusLine>
        </section>

        <section className="panel panel-pad stack" aria-labelledby="set-custom">
          <div className="section-head">
            <h2 id="set-custom" className="h-sub">
              <Blocks size={18} aria-hidden="true" /> Custom code builder
            </h2>
            <Pill tone="neutral">{h.customCodeBuilder.enabled ? 'Enabled' : 'Disabled'}</Pill>
          </div>
          <p className="muted small">{h.customCodeBuilder.reason}</p>
          <p className="subtle small">The extension point and the isolation it requires (no network, no host secrets, allowlisted tools, resource limits, an isolated preview origin and creator approval before export) are described in docs/CUSTOM_CODE_BUILDER.md.</p>
        </section>

        <section className="panel panel-pad stack" aria-labelledby="set-limits">
          <h2 id="set-limits" className="h-sub">
            <Cpu size={18} aria-hidden="true" /> Limits
          </h2>
          <dl className="kv">
            <dt>Upload size</dt>
            <dd>{formatBytes(h.limits.maxUploadBytes)}</dd>
            <dt>Slides per deck</dt>
            <dd>{h.limits.maxSlides}</dd>
            <dt>Expanded package size</dt>
            <dd>{formatBytes(h.limits.maxExpandedBytes)}</dd>
            <dt>Package entries</dt>
            <dd>{h.limits.maxEntries}</dd>
            <dt>XML part size</dt>
            <dd>{formatBytes(h.limits.maxXmlBytes)}</dd>
            <dt>Image size</dt>
            <dd>{Math.round(h.limits.maxImagePixels / 1e6)} megapixels</dd>
            <dt>Asset file size</dt>
            <dd>{formatBytes(h.limits.maxAssetBytes)}</dd>
          </dl>
          <p className="subtle small">Change these with environment variables (see .env.example). Data is stored in {h.dataDir}.</p>
        </section>

        <section className="panel panel-pad stack" aria-labelledby="set-usage">
          <div className="section-head">
            <h2 id="set-usage" className="h-sub">
              Claude usage
            </h2>
            {usage.data?.pricing ? (
              <span className="subtle small">
                Estimates use pricing as of {usage.data.pricing.asOf} ({usage.data.pricing.source})
              </span>
            ) : h.pricing.error ? (
              <span className="meta-warn small">Token counts only — {h.pricing.error}</span>
            ) : (
              <span className="subtle small">Token counts only — no pricing file configured (CLAUDE_PRICING_FILE)</span>
            )}
          </div>
          {(usage.data?.rows ?? []).length === 0 ? (
            <p className="subtle small">No Claude calls yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Model</th>
                    <th scope="col" className="tabular">
                      Input
                    </th>
                    <th scope="col" className="tabular">
                      Output
                    </th>
                    <th scope="col" className="tabular">
                      Cache read
                    </th>
                    {usage.data?.pricing && <th scope="col">Estimate</th>}
                  </tr>
                </thead>
                <tbody>
                  {usage.data!.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{formatDate(r.created_at)}</td>
                      <td>{r.stage}</td>
                      <td className="mono small">{r.model}</td>
                      <td className="tabular">{formatTokens(r.input_tokens)}</td>
                      <td className="tabular">{formatTokens(r.output_tokens)}</td>
                      <td className="tabular">{formatTokens(r.cache_read_tokens)}</td>
                      {usage.data?.pricing && <td className="tabular">{r.estimatedUsd !== null ? `≈ $${r.estimatedUsd.toFixed(4)} (estimate)` : '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
