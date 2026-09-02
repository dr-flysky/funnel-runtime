/**
 * Publish the iteration-1 configs so a fresh clone has something to run.
 * Idempotent in spirit: re-running appends new versions rather than failing,
 * which is also a cheap way to exercise publish/rollback by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../server/db.ts';
import { publishVersion, listVersions } from '../server/versions.ts';
import type { FunnelConfig } from '@shared/funnel';

const FILES = ['v1-quickcash.json', 'v1-cardmatch.json'];

function main(): void {
  getDb();
  for (const file of FILES) {
    const full = path.resolve(process.cwd(), 'configs', file);
    if (!fs.existsSync(full)) {
      console.error(`  ! configs/${file} not found, skipping`);
      continue;
    }
    const config = JSON.parse(fs.readFileSync(full, 'utf8')) as FunnelConfig;
    const summary = publishVersion(config, { note: `Seeded from ${file}` });
    console.log(
      `  ✓ ${summary.funnelKey} v${summary.version} — ${summary.stepCount} steps, variants ${summary.variants.join('/')}`,
    );
  }

  console.log('\nActive versions:');
  for (const key of new Set(FILES.map((f) => JSON.parse(fs.readFileSync(path.resolve('configs', f), 'utf8')).key))) {
    const active = listVersions(key as string).find((v) => v.isActive);
    console.log(`  ${key}: v${active?.version ?? '—'}`);
  }
}

main();
