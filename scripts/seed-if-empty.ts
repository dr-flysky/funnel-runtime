/**
 * First-boot seed. Publishes the iteration-1 configs only when the database
 * has no versions yet, so a redeploy never resets a live funnel or duplicates
 * versions on top of an existing history.
 */
import { getDb } from '../server/db.ts';
import { listFunnelKeys } from '../server/versions.ts';

getDb();

if (listFunnelKeys().length > 0) {
  console.log('[seed] versions already present, leaving the database alone');
} else {
  console.log('[seed] empty database, publishing iteration-1 configs');
  await import('./seed.ts');
}
