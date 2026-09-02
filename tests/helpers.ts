import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, setDb } from '../server/db.ts';
import { publishVersion, type VersionSummary } from '../server/versions.ts';
import { createApp } from '../server/app.ts';
import type { FunnelConfig } from '@shared/funnel';

/** Fresh in-memory database for each test, so nothing leaks between them. */
export function useFreshDb(): void {
  setDb(openDb(':memory:'));
}

export function loadConfig(file: string): FunnelConfig {
  const full = path.resolve(process.cwd(), 'configs', file);
  return JSON.parse(fs.readFileSync(full, 'utf8')) as FunnelConfig;
}

export function seedV1(): VersionSummary {
  return publishVersion(loadConfig('v1-quickcash.json'), { note: 'test v1' });
}

export function publishV2(): VersionSummary {
  return publishVersion(loadConfig('v2-quickcash.json'), { note: 'test v2' });
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
