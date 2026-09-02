/** Roll the funnel back to the previously active version: npm run rollback */
import { getDb } from '../server/db.ts';
import { rollbackToPrevious, listVersions } from '../server/versions.ts';

const funnelKey = process.argv[2] ?? process.env.DEFAULT_FUNNEL_KEY ?? 'quickcash';

getDb();
const before = listVersions(funnelKey).find((v) => v.isActive);
const after = rollbackToPrevious(funnelKey, process.argv[3] ?? 'Manual rollback via CLI');

console.log(`✓ ${funnelKey}: v${before?.version ?? '?'} -> v${after.version}`);
console.log('  new sessions now start on v' + after.version);
console.log('  sessions pinned to v' + (before?.version ?? '?') + ' keep running on it; their analytics are untouched');
