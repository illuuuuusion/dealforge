/** Web Push (VAPID) for alerts. Every send is logged per subscription; "shown" only comes from a service worker receipt. */
import webpush from 'web-push';
import * as repo from '@dealforge/db';

export interface PushTarget { endpoint: string; keys: { p256dh: string; auth: string } }
/** Returns the push service's HTTP status; throws only on network errors. */
export type PushSend = (target: PushTarget, payload: string) => Promise<number>;

export async function vapidKeys(db: repo.Queryable, keys: repo.SecretKeys) {
  return JSON.parse(await repo.getOrCreateSecret(db, 'vapid', () => JSON.stringify(webpush.generateVAPIDKeys()), keys)) as { publicKey: string; privateKey: string };
}
export async function createPushSender(db: repo.Queryable, config: repo.SecretKeys & { vapidSubject: string }): Promise<PushSend> {
  const vapidDetails = { subject: config.vapidSubject, ...await vapidKeys(db, config) };
  return async (target, payload) => {
    try {
      return (await webpush.sendNotification(target, payload, { vapidDetails, TTL: 3600, urgency: 'high', timeout: 10_000 })).statusCode;
    } catch (e) {
      if (e instanceof webpush.WebPushError) return e.statusCode;
      throw e;
    }
  };
}

const outcome = (status: number) => status >= 200 && status < 300 ? 'sent' as const : status === 404 || status === 410 ? 'gone' as const : 'failed' as const;
/** Sends to every subscription that has not received this alert yet; a retry only resends failed deliveries. */
export async function deliver(db: repo.Db, send: PushSend, alertId: number | null, message: Record<string, unknown>) {
  const result = { sent: 0, failed: 0, gone: 0, skipped: 0 };
  for (const sub of await repo.pushSubscriptions(db)) {
    const d = await repo.startDelivery(db, alertId, sub.id);
    if (d.status === 'sent' || d.status === 'gone') { result.skipped++; continue; }
    try {
      const httpStatus = await send(sub, JSON.stringify({ ...message, deliveryId: d.id }));
      const status = outcome(httpStatus);
      await repo.finishDelivery(db, d.id, { status, httpStatus });
      result[status]++;
    } catch (e) {
      await repo.finishDelivery(db, d.id, { status: 'failed', error: (e as Error).message });
      result.failed++;
    }
  }
  return result;
}

const label: Record<string, string> = { SCHNAPPER: 'Schnapper', DEAL: 'Preisalarm', REPAIR: 'Repair-Kandidat', PRICE_DROP: 'Preissturz' };
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
export async function dispatchAlert(db: repo.Db, send: PushSend, alertId: number) {
  const a = await repo.getAlert(db, alertId);
  if (!a) return null; // listing deleted meanwhile
  return deliver(db, send, a.id, { title: `DealForge: ${label[a.kind] ?? a.kind}`, body: `${a.title} · ${eur.format(a.priceEur)}`,
    url: a.url, tag: `dealforge-alert-${a.id}`, alertId: a.id });
}
