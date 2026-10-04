import './styles.css';
import { gameConfigSchema, type GameConfig } from '@shared/schemas/game.ts';
import { parentToPreviewSchema, PREVIEW_PROTOCOL, previewInitSchema, type PreviewToParent } from '@shared/schemas/preview.ts';
import { h, clear } from './dom.ts';
import { Game } from './game.ts';

/**
 * Entry point. Two modes:
 *  - exported game: `window.NEXUS_GAME_CONFIG` is defined by game.config.js;
 *  - studio preview: inside a sandboxed iframe (opaque origin). The studio
 *    sends a nonce and a MessagePort; every message is schema-checked and must
 *    carry the nonce. The runtime never touches network, storage or the parent DOM.
 */

declare global {
  interface Window {
    NEXUS_GAME_CONFIG?: unknown;
  }
}

function mountPoint(): HTMLElement {
  return document.getElementById('nexus-game') ?? document.body.appendChild(h('main', { attrs: { id: 'nexus-game' } }));
}

function showError(root: HTMLElement, message: string): void {
  clear(root);
  root.classList.add('nx-root');
  root.appendChild(
    h('div', { class: 'nx-error-screen', attrs: { role: 'alert' } }, h('h1', { text: 'This game could not start' }), h('p', { text: message })),
  );
}

function validate(raw: unknown): { config: GameConfig } | { error: string } {
  const parsed = gameConfigSchema.safeParse(raw);
  if (parsed.success) return { config: parsed.data };
  const issue = parsed.error.issues[0];
  return { error: `The game configuration is invalid${issue ? ` (${issue.path.join('.') || 'root'}: ${issue.message})` : ''}.` };
}

function startStandalone(raw: unknown): void {
  const root = mountPoint();
  const result = validate(raw);
  if ('error' in result) return showError(root, result.error);
  const assets = new Map<string, string>();
  for (const a of Object.values(result.config.assets)) assets.set(a.id, a.file);
  document.title = result.config.title;
  const game = new Game(root, result.config, assets, () => {});
  game.showTitle();
}

function startPreview(): void {
  const root = mountPoint();
  let port: MessagePort | null = null;
  let nonce = '';
  let game: Game | null = null;
  let blobUrls: string[] = [];

  const send = (msg: PreviewToParent) => port?.postMessage(msg);

  window.addEventListener('error', (e) => send({ type: 'error', nonce, message: String(e.message).slice(0, 400) }));

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || port) return;
    const init = previewInitSchema.safeParse(event.data);
    if (!init.success || !event.ports[0]) return;
    nonce = init.data.nonce;
    port = event.ports[0];
    port.onmessage = (e: MessageEvent) => {
      const msg = parentToPreviewSchema.safeParse(e.data);
      if (!msg.success || msg.data.nonce !== nonce) return; // ignore anything unexpected
      const m = msg.data;
      if (m.type === 'load') {
        const result = validate(m.config);
        if ('error' in result) {
          showError(root, result.error);
          send({ type: 'error', nonce, message: result.error });
          return;
        }
        game?.destroy();
        for (const u of blobUrls) URL.revokeObjectURL(u);
        blobUrls = [];
        const assets = new Map<string, string>();
        for (const a of m.assets) {
          const url = URL.createObjectURL(new Blob([a.data], { type: a.mime }));
          blobUrls.push(url);
          assets.set(a.id, url);
        }
        const editor = m.editor;
        const sendScreen = () => {
          if (!game) return;
          send({ type: 'screen', nonce, screenId: game.currentScreenId });
          // Positions are measured after layout settles.
          if (editor) requestAnimationFrame(() => requestAnimationFrame(() => game && send({ type: 'entities', nonce, screenId: game.currentScreenId, rects: game.entityRects() })));
        };
        game = new Game(
          root,
          result.config,
          assets,
          (event, sceneId, detail) => {
            send({ type: 'progress', nonce, event, sceneId, correct: detail?.correct ?? null, attempt: detail?.attempt ?? null, hintLevel: detail?.hintLevel ?? null });
            if (event === 'title-shown' || event === 'scene-started' || event === 'game-completed') sendScreen();
          },
          (s) => send({ type: 'state', nonce, ...s }),
          { editor, onMotionEvent: editor ? (e) => send({ type: 'motion-event', nonce, kind: e.kind, bindingId: e.bindingId.slice(0, 40), reason: e.reason?.slice(0, 200) ?? null }) : undefined },
        );
        if (m.startSceneId) game.goto(m.startSceneId);
        else game.showTitle();
        send({ type: 'loaded', nonce, sceneCount: result.config.scenes.length });
        return;
      }
      if (!game) return;
      if (m.type === 'motion') {
        switch (m.action) {
          case 'fire':
            if (m.trigger) game.motionFire({ type: m.trigger.event, control: m.trigger.control, entities: m.trigger.entities });
            break;
          case 'play':
            if (m.bindingId) game.motionPlay(m.bindingId);
            break;
          case 'pause':
            game.motionPause();
            break;
          case 'resume':
            game.motionResume();
            break;
          case 'rate':
            game.motionRate(m.value ?? 1);
            break;
          case 'stop':
            game.motionStop();
            break;
          case 'restart':
            game.motionRestart();
            break;
          case 'sound':
            game.setEditorSound((m.value ?? 0) > 0);
            break;
          case 'entities':
            send({ type: 'entities', nonce, screenId: game.currentScreenId, rects: game.entityRects() });
            break;
        }
        return;
      }
      switch (m.command) {
        case 'restart':
          game.restart();
          break;
        case 'goto':
          game.goto(m.sceneId);
          break;
        case 'pause':
          game.pause();
          break;
        case 'resume':
          game.resume();
          break;
        case 'mute':
          game.setMuted(true);
          break;
        case 'unmute':
          game.setMuted(false);
          break;
      }
    };
    port.start();
    send({ type: 'ready', nonce });
  });

  // Ask the parent for a channel. The hello carries no data.
  window.parent.postMessage({ type: 'nexus:hello', protocol: PREVIEW_PROTOCOL }, '*');
  root.classList.add('nx-root');
  root.appendChild(h('p', { class: 'nx-waiting', text: 'Waiting for the studio…' }));
}

if (window.NEXUS_GAME_CONFIG !== undefined) startStandalone(window.NEXUS_GAME_CONFIG);
else if (window.parent !== window) startPreview();
else showError(mountPoint(), 'No game configuration was found. Open the exported index.html from the game folder.');
