/**
 * Publish the supplied config so a fresh clone has something to run.
 * Re-running appends a new version rather than failing, which is also a cheap
 * way to exercise publish/rollback by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../server/db.ts';
import { publishVersion, listVersions, ConfigValidationError } from '../server/versions.ts';
import type { FunnelConfig } from '@shared/funnel';

const FILES = ['funnel-v1.json'];

function main(): void {
  getDb();
  const funnelKeys = new Set<string>();

  for (const file of FILES) {
    const full = path.resolve(process.cwd(), 'configs', file);
    if (!fs.existsSync(full)) {
      console.error(`  ! configs/${file} not found, skipping`);
      continue;
    }

    const config = JSON.parse(fs.readFileSync(full, 'utf8')) as FunnelConfig;
    try {
      const summary = publishVersion(config, { note: `Seeded from ${file}` });
      funnelKeys.add(summary.funnelKey);
      console.log(
        `  ✓ ${summary.funnelKey} v${summary.version} — ${summary.stepCount} steps, ` +
          `${summary.resultCount} results, variants ${summary.variants.join('/')}`,
      );
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        console.error(`  ✗ ${file} rejected:`);
        for (const issue of err.issues) console.error(`      - ${issue}`);
        process.exitCode = 2;
        continue;
      }
      throw err;
    }
  }

  if (funnelKeys.size > 0) {
    console.log('\nActive versions:');
    for (const key of funnelKeys) {
      const active = listVersions(key).find((v) => v.isActive);
      console.log(`  ${key}: v${active?.version ?? '—'}`);
    }
  }
}

main();
