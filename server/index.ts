/** Точка входа: поднимает API и, если он собран, статический клиент. */
import { createApp } from './app.ts';
import { getDb } from './db.ts';
import { listFunnelKeys } from './versions.ts';

const port = Number(process.env.PORT ?? 3000);

getDb(); // открыть и мигрировать БД до приёма трафика

const app = createApp();
app.listen(port, () => {
  const funnels = listFunnelKeys();
  console.log(`[funnel-runtime] listening on http://localhost:${port}`);
  console.log(
    funnels.length > 0
      ? `[funnel-runtime] funnels: ${funnels.join(', ')}`
      : '[funnel-runtime] no funnels published yet — run: npm run seed',
  );
});
