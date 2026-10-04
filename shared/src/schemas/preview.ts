import { z } from 'zod';
import { entityIdSchema, motionTrigger } from './motion.ts';

/**
 * Messages between the studio and the sandboxed preview iframe. The iframe has
 * an opaque origin, so every message also carries a per-session nonce and is
 * checked against these schemas and the expected window/port.
 */

export const PREVIEW_PROTOCOL = 1 as const;

const nonce = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const previewHelloSchema = z.object({ type: z.literal('nexus:hello'), protocol: z.literal(PREVIEW_PROTOCOL) });
export const previewInitSchema = z.object({ type: z.literal('nexus:init'), protocol: z.literal(PREVIEW_PROTOCOL), nonce });

export const previewAssetPayloadSchema = z.object({
  id: z.string().max(64),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4']),
  data: z.instanceof(ArrayBuffer),
});

export const parentToPreviewSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('load'),
    nonce,
    /** Validated again by the runtime against the GameConfig schema. */
    config: z.unknown(),
    assets: z.array(previewAssetPayloadSchema).max(200),
    startSceneId: z.string().max(64).nullable(),
    /** Animate workspace: report motion events and object positions; editor simulation commands allowed. */
    editor: z.boolean().default(false),
  }),
  /**
   * Editor simulation of motion. Runs the same trusted motion code, but never
   * calls a mechanic: no answer is submitted, no progress or points change, and
   * animation sounds stay off unless the creator turns them on.
   */
  z.object({
    type: z.literal('motion'),
    nonce,
    action: z.enum(['fire', 'play', 'pause', 'resume', 'rate', 'stop', 'restart', 'sound', 'entities']),
    trigger: z.object({ event: motionTrigger, control: z.string().max(20).nullable(), entities: z.array(entityIdSchema).max(4) }).nullable(),
    bindingId: z.string().max(40).nullable(),
    value: z.number().min(0).max(4).nullable(),
  }),
  z.object({
    type: z.literal('command'),
    nonce,
    command: z.enum(['restart', 'pause', 'resume', 'goto', 'mute', 'unmute']),
    sceneId: z.string().max(64).nullable(),
  }),
]);
export type ParentToPreview = z.infer<typeof parentToPreviewSchema>;

export const previewProgressEvent = z.enum(['title-shown', 'scene-started', 'scene-completed', 'attempt', 'hint', 'game-completed', 'restarted']);

export const previewToParentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), nonce }),
  z.object({ type: z.literal('loaded'), nonce, sceneCount: z.number().int().min(0).max(100) }),
  z.object({
    type: z.literal('progress'),
    nonce,
    event: previewProgressEvent,
    sceneId: z.string().max(64).nullable(),
    correct: z.boolean().nullable(),
    attempt: z.number().int().min(0).max(1000).nullable(),
    hintLevel: z.number().int().min(0).max(10).nullable(),
  }),
  z.object({ type: z.literal('state'), nonce, paused: z.boolean(), muted: z.boolean(), sceneId: z.string().max(64).nullable() }),
  z.object({ type: z.literal('error'), nonce, message: z.string().max(500) }),
  z.object({ type: z.literal('screen'), nonce, screenId: z.string().max(64) }),
  z.object({
    type: z.literal('motion-event'),
    nonce,
    kind: z.enum(['started', 'finished', 'skipped', 'cancelled']),
    bindingId: z.string().max(40),
    reason: z.string().max(200).nullable(),
  }),
  z.object({
    type: z.literal('entities'),
    nonce,
    screenId: z.string().max(64),
    rects: z.array(z.object({ id: entityIdSchema, x: z.number(), y: z.number(), w: z.number(), h: z.number() })).max(200),
  }),
]);
export type PreviewToParent = z.infer<typeof previewToParentSchema>;
