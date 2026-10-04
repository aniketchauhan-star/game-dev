import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import type { MotionTrigger } from '@shared/schemas/motion.ts';
import { previewHelloSchema, previewToParentSchema, PREVIEW_PROTOCOL, type PreviewToParent } from '@shared/schemas/preview.ts';
import type { PreviewBundle } from '../../lib/queries.ts';
import { Spinner } from '../ui/feedback.tsx';

/**
 * Sandboxed game preview.
 *  - iframe sandbox="allow-scripts" WITHOUT allow-same-origin: the game runs in
 *    an opaque origin with no access to the studio DOM, cookies or storage;
 *  - the preview document is served with its own strict CSP (no network);
 *  - config and asset bytes go over a MessageChannel created after the
 *    iframe's hello; every message is schema-checked and carries a nonce;
 *  - only the trusted runtime runs inside; nothing secret is ever sent.
 */

export type FitMode = 'fit' | '100' | '75' | '50';

export interface PreviewHandle {
  restart(): void;
  pause(): void;
  resume(): void;
  goto(sceneId: string | null): void;
  setMuted(m: boolean): void;
  /** Editor simulation of motion (Animate workspace). Never runs a mechanic. */
  motion(action: 'fire' | 'play' | 'pause' | 'resume' | 'rate' | 'stop' | 'restart' | 'sound' | 'entities', args?: { trigger?: { event: MotionTrigger; control: string | null; entities: string[] }; bindingId?: string; value?: number }): void;
}

export type PreviewMotionMessage = Extract<PreviewToParent, { type: 'motion-event' | 'entities' | 'screen' }>;

export interface PreviewState {
  status: 'connecting' | 'loading' | 'ready' | 'error';
  paused: boolean;
  muted: boolean;
  sceneId: string | null;
  error: string | null;
}

function randomNonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
}

const assetCache = new Map<string, Promise<ArrayBuffer>>();
function fetchAsset(url: string): Promise<ArrayBuffer> {
  let p = assetCache.get(url);
  if (!p) {
    p = fetch(url, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error(`Asset request failed (${r.status})`);
      return r.arrayBuffer();
    });
    assetCache.set(url, p);
    p.catch(() => assetCache.delete(url));
  }
  return p;
}

export const GamePreview = forwardRef<
  PreviewHandle,
  {
    bundle: PreviewBundle | undefined;
    startSceneId?: string | null;
    fit: FitMode;
    onEvent?: (msg: Extract<PreviewToParent, { type: 'progress' | 'error' }>) => void;
    onState?: (s: PreviewState) => void;
    title?: string;
    /** Animate workspace: motion events and object positions are reported. */
    editor?: boolean;
    onMotion?: (msg: PreviewMotionMessage) => void;
    /** Drawn over the stage, in 1920×1080 stage coordinates scaled to the frame. */
    overlay?: (scale: number) => ReactNode;
  }
>(function GamePreview({ bundle, startSceneId = null, fit, onEvent, onState, title = 'Game preview', editor = false, onMotion, overlay }, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const nonceRef = useRef<string>('');
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [state, setState] = useState<PreviewState>({ status: 'connecting', paused: false, muted: false, sceneId: null, error: null });
  const [channelReady, setChannelReady] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const onMotionRef = useRef(onMotion);
  onMotionRef.current = onMotion;
  // The screen the runtime reports, and whether a load is in flight (so a goto never races a reload).
  const runtimeScreenRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  // Stable so the handshake effect never re-runs (and drops the channel) when the parent re-renders.
  const update = useCallback((patch: Partial<PreviewState>) => setState((s) => ({ ...s, ...patch })), []);
  // Report state after commit — never from inside a state updater.
  useEffect(() => {
    onStateRef.current?.(state);
  }, [state]);

  // Fit the 16:9 stage to the available width AND height — never stretched or cropped.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      if (fit !== 'fit') {
        const pct = Number(fit) / 100;
        setSize({ w: Math.round(1920 * pct), h: Math.round(1080 * pct) });
        return;
      }
      const s = Math.max(1, Math.min(el.clientWidth / 16, el.clientHeight / 9));
      setSize({ w: Math.floor(s * 16), h: Math.floor(s * 9) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Handshake: only the iframe we created (opaque origin "null") may open a channel.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      if (e.origin !== 'null') return;
      if (!previewHelloSchema.safeParse(e.data).success) return;
      portRef.current?.close();
      const channel = new MessageChannel();
      const nonce = randomNonce();
      nonceRef.current = nonce;
      portRef.current = channel.port1;
      channel.port1.onmessage = (ev: MessageEvent) => {
        const parsed = previewToParentSchema.safeParse(ev.data);
        if (!parsed.success || parsed.data.nonce !== nonceRef.current) return;
        const m = parsed.data;
        if (m.type === 'ready') setChannelReady(true);
        else if (m.type === 'loaded') {
          loadingRef.current = false;
          update({ status: 'ready', error: null });
        }
        else if (m.type === 'state') update({ paused: m.paused, muted: m.muted, sceneId: m.sceneId });
        else if (m.type === 'error') {
          loadingRef.current = false;
          update({ error: m.message });
          onEventRef.current?.(m);
        } else if (m.type === 'motion-event' || m.type === 'entities' || m.type === 'screen') {
          if (m.type === 'screen') runtimeScreenRef.current = m.screenId;
          onMotionRef.current?.(m);
        }
        else onEventRef.current?.(m);
      };
      channel.port1.start();
      frame.contentWindow!.postMessage({ type: 'nexus:init', protocol: PREVIEW_PROTOCOL, nonce }, '*', [channel.port2]);
      update({ status: 'loading' });
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      portRef.current?.close();
      portRef.current = null;
      setChannelReady(false);
    };
  }, [frameKey, update]);

  // Send the config and asset bytes (never URLs with credentials, never secrets).
  useEffect(() => {
    if (!channelReady || !bundle || !portRef.current) return;
    let cancelled = false;
    loadingRef.current = true;
    update({ status: 'loading' });
    (async () => {
      try {
        const assets = await Promise.all(
          bundle.assets.filter((a) => a.available).map(async (a) => ({ id: a.id, mime: a.mime, data: (await fetchAsset(a.url)).slice(0) })),
        );
        if (cancelled || !portRef.current) return;
        portRef.current.postMessage({ type: 'load', nonce: nonceRef.current, config: bundle.config, assets, startSceneId, editor });
      } catch (err) {
        if (!cancelled) {
          loadingRef.current = false;
          update({ status: 'error', error: (err as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelReady, bundle?.version.id, bundle?.config]);

  const command = (cmd: 'restart' | 'pause' | 'resume' | 'goto' | 'mute' | 'unmute', sceneId: string | null = null) =>
    portRef.current?.postMessage({ type: 'command', nonce: nonceRef.current, command: cmd, sceneId });

  // Follow the chosen screen without reloading. Skipped while a load (which starts there) is in flight,
  // and when the runtime is already on that screen (e.g. the player pressed Start in the preview).
  useEffect(() => {
    if (!startSceneId || state.status !== 'ready' || loadingRef.current || !portRef.current) return;
    if ((runtimeScreenRef.current ?? 'title') === startSceneId) return;
    command('goto', startSceneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSceneId, state.status]);

  useImperativeHandle(ref, () => ({
    restart: () => command('restart'),
    pause: () => command('pause'),
    resume: () => command('resume'),
    goto: (id) => command('goto', id),
    setMuted: (m) => command(m ? 'mute' : 'unmute'),
    motion: (action, args = {}) =>
      portRef.current?.postMessage({ type: 'motion', nonce: nonceRef.current, action, trigger: args.trigger ?? null, bindingId: args.bindingId ?? null, value: args.value ?? null }),
  }));

  return (
    <div className={`preview-box${fit === 'fit' ? '' : ' is-zoomed'}`} ref={boxRef}>
      <div className="preview-frame" style={{ width: size.w, height: size.h }}>
        <iframe
          key={frameKey}
          ref={iframeRef}
          className="preview-iframe"
          title={`${title} (sandboxed)`}
          src="/preview/index.html"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
          width={size.w}
          height={size.h}
        />
        {overlay && state.status === 'ready' && <div className="preview-stage-overlay">{overlay(size.w / 1920)}</div>}
        {state.status !== 'ready' && state.status !== 'error' && (
          <div className="preview-overlay">
            <Spinner label={state.status === 'connecting' ? 'Starting the sandboxed preview…' : 'Loading the game…'} />
          </div>
        )}
        {state.status === 'error' && (
          <div className="preview-overlay is-error" role="alert">
            <p>The preview could not load: {state.error}</p>
            <button type="button" className="btn btn-sm" onClick={() => setFrameKey((k) => k + 1)}>
              Reload preview
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
