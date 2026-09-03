/**
 * Назначение A/B-варианта.
 *
 * Стабильность держится на двух независимых гарантиях: назначение — чистая функция
 * от (sessionId, experimentId), а результат ещё и записан в строку сессии при её создании.
 */
import type { FunnelConfig } from '@shared/funnel';

/** FNV-1a, 32 бита: компактно, быстро и хорошо распределено на коротких ключах. */
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

/** `override` из query-параметра выигрывает, если такой вариант есть в конфиге, и помечается для аналитики. */
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

  // 10 000 корзин дают точность весов до одной сотой процента.
  const bucket = hash32(`${config.experiment.id}:${sessionId}`) % 10_000;
  const target = (bucket / 10_000) * total;

  let cumulative = 0;
  for (let i = 0; i < keys.length; i += 1) {
    cumulative += weights[i];
    if (target < cumulative) return { variant: keys[i], source: 'assigned' };
  }
  return { variant: keys[keys.length - 1], source: 'assigned' };
}
