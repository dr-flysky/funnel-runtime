/**
 * HTTP surface. Exported as a factory so tests can mount it against an
 * isolated database without binding a port.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ingestEvents, type IncomingEvent } from './events.ts';
import {
  buildView,
  createSession,
  funnelForSession,
  getSession,
  goBack,
  isExpired,
  NoActiveVersionError,
  pickUtm,
  submitAnswer,
} from './sessions.ts';
import {
  ConfigValidationError,
  activateVersion,
  getActiveVersionRow,
  listActivations,
  listFunnelKeys,
  listVersions,
  parseConfig,
  publishVersion,
  rollbackToPrevious,
} from './versions.ts';
import { buildReport } from './analytics.ts';
import type { FunnelConfig } from '@shared/funnel';

const DEFAULT_FUNNEL = process.env.DEFAULT_FUNNEL_KEY ?? 'workstyle-planner';

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Map a session-write refusal onto a status code.
 *
 * "Gone" and "never existed" are the two cases the client can recover from by
 * starting a fresh session, so they get their own codes. Everything else is a
 * 400 the user can fix in place — a failed validation rule, a stale step id.
 */
function statusFor(error: string | undefined): number {
  if (error === 'Unknown session.') return 404;
  if (error === 'Session expired.') return 410;
  return 400;
}

/**
 * Admin guard. Open by default so the deployed URL can be reviewed without
 * credentials; set ADMIN_TOKEN to require `x-admin-token` (or HTTP basic auth
 * with any username) on every mutating admin route.
 */
function adminGuard(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return next();

  const header = req.get('x-admin-token');
  if (header && header === expected) return next();

  const auth = req.get('authorization') ?? '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (password === expected) return next();
  }

  res.status(401).set('WWW-Authenticate', 'Basic realm="Funnel admin"').json({
    error: 'Admin token required.',
  });
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // -------------------------------------------------------------------------
  // Runtime — the funnel itself
  // -------------------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, funnels: listFunnelKeys() });
  });

  app.get('/api/funnels', (_req, res) => {
    const keys = listFunnelKeys();
    res.json({
      funnels: keys.map((key) => {
        const active = getActiveVersionRow(key);
        return {
          key,
          activeVersion: active?.version ?? null,
          name: active ? parseConfig(active).title : key,
        };
      }),
    });
  });

  /** Start a session. Pins the active version and an A/B variant to it. */
  app.post('/api/session', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const funnelKey = asString(body.funnelKey) ?? DEFAULT_FUNNEL;
    const variantOverride = asString(body.variant);
    const utm = pickUtm(body.utm as Record<string, unknown> | undefined);

    try {
      // `synthetic` marks generator traffic so the dashboard can exclude it.
      const view = createSession({
        funnelKey,
        utm,
        variantOverride,
        synthetic: body.synthetic === true,
      });
      res.status(201).json(view);
    } catch (err) {
      if (err instanceof NoActiveVersionError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  /**
   * Resume. This is what makes refresh and reopening the page lossless.
   *
   * A session past its TTL answers 410 rather than 200: every write route
   * already refuses it, so serving a renderable view would hand the client a
   * funnel that dies on the next Continue. 410 is the signal to start fresh.
   */
  app.get('/api/session/:id', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Unknown session.' });
      return;
    }
    if (isExpired(session, funnelForSession(session))) {
      res.status(410).json({ error: 'Session expired.' });
      return;
    }
    res.json(buildView(session));
  });

  app.post('/api/session/:id/answer', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const stepId = asString(body.stepId);
    if (!stepId) {
      res.status(400).json({ error: 'stepId is required.' });
      return;
    }

    const result = submitAnswer(req.params.id, stepId, body.value);
    if (!result.ok) {
      res.status(statusFor(result.error)).json({ error: result.error });
      return;
    }
    res.json({
      ...result.view,
      answerSummary: result.answerSummary,
      reachedResult: result.reachedResult,
    });
  });

  app.post('/api/session/:id/back', (req, res) => {
    const result = goBack(req.params.id);
    if (!result.ok) {
      res.status(statusFor(result.error)).json({ error: result.error });
      return;
    }
    res.json(result.view);
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Batch ingest. Always 200 when the envelope parses: per-event verdicts are
   * in the body, so a retrying client can tell a duplicate from a rejection
   * without inspecting status codes.
   */
  app.post('/api/events', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(body.events) ? body.events : Array.isArray(body) ? body : null;
    if (!raw) {
      res.status(400).json({ error: 'Body must be { events: [...] } or an array of events.' });
      return;
    }
    if (raw.length > 500) {
      res.status(413).json({ error: 'Batch too large; send at most 500 events.' });
      return;
    }
    res.json(ingestEvents(raw as IncomingEvent[]));
  });

  // -------------------------------------------------------------------------
  // Admin — versions
  // -------------------------------------------------------------------------

  app.get('/api/admin/versions', (req, res) => {
    const funnelKey = asString(req.query.funnelKey) ?? DEFAULT_FUNNEL;
    res.json({
      funnelKey,
      versions: listVersions(funnelKey),
      activations: listActivations(funnelKey),
    });
  });

  /** Publish a new version. Rejected configs never become active. */
  app.post('/api/admin/versions', adminGuard, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const config = body.config as FunnelConfig | undefined;
    if (!config || typeof config !== 'object') {
      res.status(400).json({ error: 'config is required.' });
      return;
    }
    try {
      const summary = publishVersion(config, {
        note: asString(body.note) ?? undefined,
        activate: body.activate !== false,
      });
      res.status(201).json(summary);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(422).json({ error: err.message, issues: err.issues });
        return;
      }
      throw err;
    }
  });

  app.post('/api/admin/activate', adminGuard, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const funnelKey = asString(body.funnelKey) ?? DEFAULT_FUNNEL;
    const versionId = Number(body.versionId);
    if (!Number.isInteger(versionId)) {
      res.status(400).json({ error: 'versionId is required.' });
      return;
    }
    try {
      res.json(activateVersion(funnelKey, versionId, 'activate', asString(body.note) ?? undefined));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/admin/rollback', adminGuard, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const funnelKey = asString(body.funnelKey) ?? DEFAULT_FUNNEL;
    try {
      res.json(rollbackToPrevious(funnelKey, asString(body.note) ?? undefined));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Config files shipped in the repo, offered as one-click publish sources. */
  app.get('/api/admin/config-files', (_req, res) => {
    const dir = path.resolve(process.cwd(), 'configs');
    if (!fs.existsSync(dir)) {
      res.json({ files: [] });
      return;
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as FunnelConfig;
          return {
            file: f,
            key: cfg.funnelId,
            name: cfg.title,
            steps: Object.keys(cfg.steps ?? {}).length,
            sourceVersion: cfg.version ?? null,
          };
        } catch {
          return { file: f, key: null, name: 'unparseable', steps: 0, sourceVersion: null };
        }
      });
    res.json({ files });
  });

  app.post('/api/admin/publish-file', adminGuard, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const file = asString(body.file);
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      res.status(400).json({ error: 'file must be a bare filename inside configs/.' });
      return;
    }
    const full = path.resolve(process.cwd(), 'configs', file);
    if (!fs.existsSync(full)) {
      res.status(404).json({ error: `configs/${file} not found.` });
      return;
    }
    try {
      const config = JSON.parse(fs.readFileSync(full, 'utf8')) as FunnelConfig;
      res.status(201).json(publishVersion(config, { note: asString(body.note) ?? `Published from ${file}` }));
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(422).json({ error: err.message, issues: err.issues });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Analytics
  // -------------------------------------------------------------------------

  app.get('/api/analytics', (req, res) => {
    const funnelKey = asString(req.query.funnelKey) ?? DEFAULT_FUNNEL;
    const versionRaw = asString(req.query.version);
    const report = buildReport({
      funnelKey,
      version: versionRaw ? Number(versionRaw) : null,
      variant: asString(req.query.variant),
      campaign: asString(req.query.campaign),
      includeSynthetic: req.query.includeSynthetic !== 'false',
      includeOverrides: req.query.includeOverrides === 'true',
    });
    res.json(report);
  });

  // -------------------------------------------------------------------------
  // Static client (production) + SPA fallback
  // -------------------------------------------------------------------------

  const clientDir = path.resolve(process.cwd(), 'dist', 'client');
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[api] unhandled error:', err);
    res.status(500).json({ error: 'Internal error.' });
  });

  return app;
}
