import fs from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pricingSchema, type Health } from '@shared/schemas/settings.ts';
import type { App } from '../../app.ts';
import { usageSummary, workerStatus } from '../../db/jobs.ts';
import { setSetting } from '../../db/misc.ts';
import { HttpError } from '../../errors.ts';
import { parse } from '../util.ts';
import { customCodeBuilder } from '../../extensions/customCodeBuilder.ts';
import { figmaStatus, testFigma } from '../../figma/index.ts';

export const APP_VERSION = '0.1.0';

/** Pricing is only ever read from a creator-supplied, dated file — never invented. */
export function loadPricing(app: App): { pricing: z.infer<typeof pricingSchema> | null; error: string | null } {
  if (!app.config.pricingFile) return { pricing: null, error: null };
  try {
    const text = fs.readFileSync(app.config.pricingFile, 'utf8');
    if (text.includes('YYYY-MM-DD') || /:\s*null/.test(text)) {
      return { pricing: null, error: 'The pricing file still has the example placeholders. Enter the date and per-million-token prices from your Claude pricing page, or remove CLAUDE_PRICING_FILE.' };
    }
    const parsed = pricingSchema.safeParse(JSON.parse(text));
    return parsed.success ? { pricing: parsed.data, error: null } : { pricing: null, error: `Pricing file is invalid: ${parsed.error.issues[0]?.message}` };
  } catch (err) {
    return { pricing: null, error: `Pricing file could not be read: ${(err as Error).message}` };
  }
}

export function settingsRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/health', async (): Promise<Health> => {
    const { pricing, error } = loadPricing(app);
    const builder = customCodeBuilder().status();
    return {
      ok: true,
      version: APP_VERSION,
      dataDir: app.config.dataDir,
      worker: workerStatus(app.db),
      claude: app.gateway.status(),
      renderer: app.renderer(),
      figma: figmaStatus(app),
      limits: app.config.limits,
      pricing: { configured: Boolean(pricing), asOf: pricing?.asOf ?? null, source: pricing?.source ?? null, error },
      customCodeBuilder: builder.enabled ? { enabled: true, reason: null } : { enabled: false, reason: builder.reason },
    };
  });

  f.get('/api/settings/claude/models', async () => {
    try {
      return { models: await app.gateway.listModels() };
    } catch (err) {
      throw new HttpError(502, 'models_unavailable', (err as Error).message);
    }
  });

  f.post('/api/settings/claude/model', async (req) => {
    const body = parse(z.object({ model: z.string().regex(/^[a-z0-9][a-z0-9.\-]{2,80}$/) }), req.body);
    if (app.config.claude.model) throw new HttpError(409, 'model_from_env', 'CLAUDE_MODEL is set in the server environment, which takes precedence.', 'Change or remove CLAUDE_MODEL and restart the server to choose here.');
    setSetting(app.db, 'claude.model', body.model);
    return { claude: await app.gateway.verify({ testRequest: false }) };
  });

  f.post('/api/settings/claude/test', async (req) => {
    const body = parse(z.object({ testRequest: z.boolean().default(false) }), req.body ?? {});
    return { claude: await app.gateway.verify({ testRequest: body.testRequest }) };
  });

  f.post('/api/settings/renderer/check', async () => ({ renderer: await app.refreshRenderer() }));

  /** Checks the server-side Figma token. The token itself is never returned. */
  f.post('/api/settings/figma/test', async () => ({ figma: await testFigma(app) }));

  f.get('/api/usage', async () => {
    const { pricing } = loadPricing(app);
    const rows = usageSummary(app.db, 200).map((r) => {
      const price = pricing?.models[r.model];
      const estimate = price
        ? (r.input_tokens * price.inputPerMTok + r.output_tokens * price.outputPerMTok + r.cache_read_tokens * (price.cacheReadPerMTok ?? price.inputPerMTok) + r.cache_write_tokens * (price.cacheWritePerMTok ?? price.inputPerMTok)) / 1_000_000
        : null;
      return { ...r, estimatedUsd: estimate };
    });
    return { rows, pricing: pricing ? { asOf: pricing.asOf, source: pricing.source } : null };
  });
}
