import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { redis } from './redis.js';

export const TOPICS = ['pre', 'spawn', 'abuse', 'news', 'events', 'waves'];
const SUBS = 'push:subs';

export async function vapid() {
  if (!redis) return null;
  let v = await redis.get('vapid');
  if (!v) {
    const k = webpush.generateVAPIDKeys();
    const ok = await redis.set('vapid', { publicKey: k.publicKey, privateKey: k.privateKey }, { nx: true });
    v = ok ? { publicKey: k.publicKey, privateKey: k.privateKey } : await redis.get('vapid');
  }
  return v;
}

export const subId = (endpoint) => createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

export async function saveSub(sub, prefs) {
  const p = {};
  for (const t of TOPICS) p[t] = !!(prefs && (t === 'events' && prefs.events === undefined ? prefs.abuse : prefs[t]));
  await redis.hset(SUBS, { [subId(sub.endpoint)]: { sub, prefs: p, t: Date.now() } });
}

export const dropSub = (endpoint) => redis.hdel(SUBS, subId(endpoint));

// Send one notification to every subscriber who opted into `topic`.
export async function sendAll(topic, payload, origin) {
  if (!redis) return { sent: 0 };
  const v = await vapid();
  webpush.setVapidDetails(origin || 'https://brainrotdex.vercel.app', v.publicKey, v.privateKey);
  const all = (await redis.hgetall(SUBS)) || {};
  const body = JSON.stringify(payload);
  let sent = 0, dropped = 0;
  const errors = [];
  const entries = Object.entries(all).filter(([, s]) => s && s.sub && s.prefs && (topic === 'events' && s.prefs.events === undefined ? s.prefs.abuse : s.prefs[topic]));
  for (let i = 0; i < entries.length; i += 50) {
    await Promise.all(entries.slice(i, i + 50).map(async ([id, s]) => {
      try {
        await webpush.sendNotification(s.sub, body, { TTL: topic === 'pre' || topic === 'spawn' ? 600 : 43200, urgency: 'high' });  // no Topic header: Apple rejects most values (BadWebPushTopic); the notification tag already replaces duplicates
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await redis.hdel(SUBS, id); dropped++; }
        else errors.push({ host: String(s.sub.endpoint).split('/')[2], status: e.statusCode || null, msg: String(e.body || e.message || '').slice(0, 160) });
      }
    }));
  }
  if (errors.length) { try { await redis.set('push:lastErrors', { at: new Date().toISOString(), topic, errors }, { ex: 7 * 86400 }); } catch {} }
  return { sent, dropped, total: entries.length, errors };
}
