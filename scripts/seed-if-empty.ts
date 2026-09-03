/**
 * Сид при первом запуске: публикует конфиги, только если версий ещё нет,
 * поэтому редеплой не сбрасывает живую воронку и не плодит версии.
 *
 * `SEED_TRAFFIC` дополнительно генерирует синтетический трафик — это нужно хостам
 * без постоянного диска, где база пуста после каждого холодного старта.
 *
 *   не задан | 0 | false   без трафика (по умолчанию)
 *   true                    партия по умолчанию
 *   250                     столько сессий
 */
import { spawnSync } from 'node:child_process';
import { getDb } from '../server/db.ts';
import { listFunnelKeys } from '../server/versions.ts';

/** Минимум по ТЗ — 100 сессий; чуть больше, чтобы каждая ветка получила трафик. */
const DEFAULT_TRAFFIC_SESSIONS = 140;

function trafficSessions(): number {
  const raw = (process.env.SEED_TRAFFIC ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'false' || raw === 'no') return 0;
  if (raw === 'true' || raw === 'yes') return DEFAULT_TRAFFIC_SESSIONS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TRAFFIC_SESSIONS;
}

getDb();

if (listFunnelKeys().length > 0) {
  console.log('[seed] versions already present, leaving the database alone');
} else {
  console.log('[seed] empty database, publishing iteration-1 configs');
  await import('./seed.ts');

  const sessions = trafficSessions();
  if (sessions > 0) {
    console.log(`[seed] SEED_TRAFFIC=${process.env.SEED_TRAFFIC} — generating ${sessions} sessions`);
    // Отдельный процесс, а не импорт: так этот скрипт не завершится раньше, чем ляжет трафик,
    // на что опирается цепочка `seed && start` в контейнере.
    // Одной строкой, а не (команда, массив аргументов): массив через shell даёт DEP0190,
    // а `sessions` — целое число, разобранное здесь же, экранировать нечего.
    const result = spawnSync(`npx tsx scripts/generate-traffic.ts ${sessions}`, {
      stdio: 'inherit',
      shell: true,
      env: process.env,
    });
    if (result.status !== 0) {
      // Демо-данные не должны блокировать старт: пустой дашборд лучше, чем упавший сервис.
      console.warn(`[seed] traffic generation exited with ${result.status}; continuing anyway`);
    }
  }
}
