/** Публикует файл конфига как новую активную версию: npm run publish -- <file> */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../server/db.ts';
import { publishVersion, ConfigValidationError } from '../server/versions.ts';
import type { FunnelConfig } from '@shared/funnel';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/publish.ts <path-to-config.json> [note]');
  process.exit(1);
}

const full = path.resolve(process.cwd(), file);
if (!fs.existsSync(full)) {
  console.error(`not found: ${full}`);
  process.exit(1);
}

getDb();
const config = JSON.parse(fs.readFileSync(full, 'utf8')) as FunnelConfig;

try {
  const summary = publishVersion(config, { note: process.argv[3] ?? `Published from ${path.basename(file)}` });
  console.log(`✓ published ${summary.funnelKey} v${summary.version} and made it active`);
  console.log(`  steps: ${summary.stepCount}, variants: ${summary.variants.join('/')}`);
  console.log('  sessions already in flight keep running on their pinned version');
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error('✗ config rejected, nothing was published:');
    for (const issue of err.issues) console.error(`   - ${issue}`);
    process.exit(2);
  }
  throw err;
}
