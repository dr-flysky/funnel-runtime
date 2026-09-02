import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, setDb } from '../server/db.ts';
import { resetEventCaches } from '../server/events.ts';
import { publishVersion, type VersionSummary } from '../server/versions.ts';
import { createApp } from '../server/app.ts';
import type { FunnelConfig } from '@shared/funnel';

/** Fresh in-memory database for each test, so nothing leaks between them. */
export function useFreshDb(): void {
  setDb(openDb(':memory:'));
  // Version ids restart from 1 in a new database, so the memoised
  // declared-event lookup must not survive the swap.
  resetEventCaches();
}

export function loadConfig(file: string): FunnelConfig {
  const full = path.resolve(process.cwd(), 'configs', file);
  return JSON.parse(fs.readFileSync(full, 'utf8')) as FunnelConfig;
}

export const FUNNEL = 'workstyle-planner';

export function seedV1(): VersionSummary {
  return publishVersion(loadConfig('funnel-v1.json'), { note: 'test v1' });
}

/**
 * A stand-in for the not-yet-supplied iteration-2 config, derived from v1 so
 * the tests exercise the shapes iteration 2 is specified to introduce: a new
 * conditional branch, a step dropped for one variant, and a new event.
 */
export function makeV2(): FunnelConfig {
  const cfg = loadConfig('funnel-v1.json');

  // 1. a new step behind a new condition
  cfg.steps.meeting_load = {
    id: 'meeting_load',
    type: 'number',
    content: { title: 'How many hours a week go to meetings?' },
    input: { name: 'meeting_load', min: 0, max: 40, step: 1, unit: 'hours' },
    validation: { required: true, messages: { required: 'Enter the meeting load.' } },
    visibleWhen: { answer: 'async_maturity', operator: 'in', value: ['low', 'medium'] },
  };

  // 2. variant A gains it; variant B drops `tool_count` entirely
  const A = cfg.experiment.variants.A;
  const B = cfg.experiment.variants.B;
  A.stepSequence = A.stepSequence.flatMap((id) =>
    id === 'tool_count' ? ['meeting_load', 'tool_count'] : [id],
  );
  B.stepSequence = B.stepSequence.filter((id) => id !== 'tool_count');

  // 3. a new event type, declared by the config alone
  cfg.events!.allowed!.push({
    name: 'help_opened',
    trigger: 'The user opens inline help on a step.',
    properties: ['surface'],
  });

  cfg.version = 2;
  return cfg;
}

export function publishV2(): VersionSummary {
  return publishVersion(makeV2(), { note: 'test v2' });
}

export interface TestServer {
  base: string;
  close: () => Promise<void>;
  post: (path: string, body: unknown) => Promise<any>;
  get: (path: string) => Promise<any>;
}

/** Boot the real app on an ephemeral port. */
export async function startServer(): Promise<TestServer> {
  const server: Server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const parse = async (res: Response) => {
    const text = await res.text();
    return { status: res.status, ...(text ? JSON.parse(text) : {}) };
  };

  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    post: async (p, body) =>
      parse(
        await fetch(base + p, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    get: async (p) => parse(await fetch(base + p)),
  };
}

/** Minimal valid event envelope. */
export function makeEvent(
  sessionId: string,
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    session_id: sessionId,
    type,
    client_ts: new Date().toISOString(),
    client_seq: 1,
    ...overrides,
  };
}
