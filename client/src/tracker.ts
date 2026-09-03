/**
 * Клиентский трекер событий.
 *
 * Идемпотентность на сервере позволяет клиенту быть простым: он сам выдаёт
 * `event_id`, держит неотправленное в localStorage и повторяет батч целиком,
 * не выясняя, дошла ли прошлая попытка.
 */

const QUEUE_KEY = 'funnel_runtime.event_queue.v1';
const FLUSH_INTERVAL_MS = 2_000;
const MAX_BATCH = 40;

export interface TrackedEvent {
  event_id: string;
  session_id: string;
  type: string;
  step_id: string | null;
  client_ts: string;
  client_seq: number;
  props: Record<string, unknown>;
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function readQueue(): TrackedEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as TrackedEvent[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(events: TrackedEvent[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(events.slice(-500)));
  } catch {
    // Хранилище переполнено или заблокировано: трекинг не вправе ломать воронку.
  }
}

class Tracker {
  private queue: TrackedEvent[] = readQueue();
  private seq = this.queue.length;
  private timer: number | null = null;
  private inFlight = false;

  constructor() {
    if (typeof window !== 'undefined') {
      // Страница, которую покидают, всё ещё должна нам свои события.
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushBeacon();
      });
      window.addEventListener('pagehide', () => this.flushBeacon());
      this.schedule();
    }
  }

  track(
    sessionId: string,
    type: string,
    stepId: string | null = null,
    props: Record<string, unknown> = {},
  ): void {
    this.seq += 1;
    this.queue.push({
      event_id: uuid(),
      session_id: sessionId,
      type,
      step_id: stepId,
      client_ts: new Date().toISOString(),
      client_seq: this.seq,
      props,
    });
    writeQueue(this.queue);
    if (this.queue.length >= MAX_BATCH) void this.flush();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Событие выбрасывается из очереди только после вердикта сервера; сбой сети оставляет его до следующего тика. */
  async flush(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return;
    this.inFlight = true;
    const batch = this.queue.slice(0, MAX_BATCH);

    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      });
      if (res.ok) this.drop(batch);
    } catch {
      // Офлайн или сервер недоступен: оставляем очередь и пробуем на следующем тике.
    } finally {
      this.inFlight = false;
    }
  }

  /** Досылка при выгрузке страницы, когда fetch уже могут отменить. */
  private flushBeacon(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.slice(0, MAX_BATCH);
    try {
      const blob = new Blob([JSON.stringify({ events: batch })], { type: 'application/json' });
      if (navigator.sendBeacon('/api/events', blob)) this.drop(batch);
    } catch {
      // Больше сделать нечего: очередь переживёт перезагрузку в localStorage.
    }
  }

  private drop(batch: TrackedEvent[]): void {
    const sent = new Set(batch.map((e) => e.event_id));
    this.queue = this.queue.filter((e) => !sent.has(e.event_id));
    writeQueue(this.queue);
  }

  get pending(): number {
    return this.queue.length;
  }
}

export const tracker = new Tracker();
