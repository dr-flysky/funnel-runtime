import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, setDb } from '../server/db.ts';
import { resetEventCaches } from '../server/events.ts';
import { publishVersion, type VersionSummary } from '../server/versions.ts';
import { createApp } from '../server/app.ts';
import type { FunnelConfig } from '@shared/funnel';

/** Своя in-memory база на каждый тест, чтобы ничего не перетекало между ними. */
export function useFreshDb(): void {
  setDb(openDb(':memory:'));
  // В новой базе id версий начинаются с 1, поэтому кэш объявленных событий пережить подмену не должен.
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
 * Заглушка ещё не присланного конфига итерации 2, собранная из v1: новая ветка по условию,
 * шаг, убранный у одного варианта, и новое событие.
 */
export function makeV2(): FunnelConfig {
  const cfg = loadConfig('funnel-v1.json');

  // 1. новый шаг за новым условием
  cfg.steps.meeting_load = {
    id: 'meeting_load',
    type: 'number',
    content: { title: 'How many hours a week go to meetings?' },
    input: { name: 'meeting_load', min: 0, max: 40, step: 1, unit: 'hours' },
    validation: { required: true, messages: { required: 'Enter the meeting load.' } },
    visibleWhen: { answer: 'async_maturity', operator: 'in', value: ['low', 'medium'] },
  };

  // 2. вариант A получает его, вариант B полностью теряет `tool_count`
  const A = cfg.experiment.variants.A;
  const B = cfg.experiment.variants.B;
  A.stepSequence = A.stepSequence.flatMap((id) =>
    id === 'tool_count' ? ['meeting_load', 'tool_count'] : [id],
  );
  B.stepSequence = B.stepSequence.filter((id) => id !== 'tool_count');

  // 3. новый тип события, объявленный только конфигом
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

/** Поднимает настоящее приложение на случайном порту. */
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

/** Минимальный валидный конверт события. */
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
