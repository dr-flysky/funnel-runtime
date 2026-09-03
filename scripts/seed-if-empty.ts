/**
 * First-boot seed. Publishes the iteration-1 configs only when the database
 * has no versions yet, so a redeploy never resets a live funnel or duplicates
 * versions on top of an existing history.
 *
 * Optionally follows up with synthetic traffic, controlled by `SEED_TRAFFIC`.
 * That exists for hosts with no persistent disk: the database is empty again
 * after every cold start, so without it the deployed dashboard would show a
 * working funnel and nothing to measure. On a host with a real volume this
 * runs once, on the very first boot, and never again.
 *
 *   SEED_TRAFFIC unset | 0 | false   no traffic (default)
 *   SEED_TRAFFIC=true                a default batch
 *   SEED_TRAFFIC=250                 that many sessions
 */
import { spawnSync } from 'node:child_process';
import { getDb } from '../server/db.ts';
import { listFunnelKeys } from '../server/versions.ts';

/** The brief's floor is 100 sessions; a little over keeps every branch populated. */
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
    // Run the generator as its own process rather than importing it: it owns a
    // module-level CLI contract and an ephemeral server, and spawning keeps the
    // sequencing unambiguous — this script cannot exit before traffic lands,
    // which is what the container's `seed && start` chain depends on.
    const result = spawnSync(
      'npx',
      ['tsx', 'scripts/generate-traffic.ts', String(sessions)],
      { stdio: 'inherit', shell: true, env: process.env },
    );
    if (result.status !== 0) {
      // Never block boot on demo data: an empty dashboard is a far better
      // outcome than a service that will not start.
      console.warn(`[seed] traffic generation exited with ${result.status}; continuing anyway`);
    }
  }
}
