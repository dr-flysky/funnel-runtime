/**
 * A/B assignment.
 *
 * Two independent guarantees of stability:
 *  1. Assignment is a pure function of (sessionId, experimentKey) — the same
 *     inputs always produce the same bucket, on any machine, with no state.
 *  2. The result is persisted on the session row at creation time and read
 *     back from there afterwards. Refresh, resume and a later config change
 *     can never move a session between variants.
 */
import type { FunnelConfig } from '@shared/funnel';

/** FNV-1a, 32-bit. Small, fast, well-distributed for short keys. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface Assignment {
  variant: string;
  source: 'assigned' | 'override';
}

/**
 * Pick a variant for a session. `override` (from a query parameter) wins when
 * it names a variant the config actually defines — that is the documented
 * testing hatch, and it is recorded as such so analytics can exclude it.
 */
export function assignVariant(
  config: FunnelConfig,
  sessionId: string,
  override?: string | null,
): Assignment {
  const variants = config.experiment?.variants ?? {};
  const keys = Object.keys(variants).sort();
  if (keys.length === 0) return { variant: 'A', source: 'assigned' };

  if (override && Object.prototype.hasOwnProperty.call(variants, override)) {
    return { variant: override, source: 'override' };
  }

  const weights = keys.map((k) => Math.max(0, variants[k].weight ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return { variant: keys[0], source: 'assigned' };

  // 10_000 buckets keeps weighting precise to a basis point.
  const bucket = hash32(`${config.experiment.key}:${sessionId}`) % 10_000;
  const target = (bucket / 10_000) * total;

  let cumulative = 0;
  for (let i = 0; i < keys.length; i += 1) {
    cumulative += weights[i];
    if (target < cumulative) return { variant: keys[i], source: 'assigned' };
  }
  return { variant: keys[keys.length - 1], source: 'assigned' };
}
