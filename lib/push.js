import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { redis } from './redis.js';

export const TOPICS = ['pre', 'spawn', 'abuse', 'news', 'events', 'waves', 'leaks', 'mine'];
const FALLBACK = { events: 'abuse', leaks: 'news' };
const want = (prefs, t) => (prefs[t] === undefined && FALLBACK[t] ? prefs[FALLBACK[t]] : prefs[t]);
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

const clean = (a, n) => (Array.isArray(a) ? [...new Set(a.map((x) => String(x || '').trim().slice(0, 60)).filter(Boolean))].slice(0, n) : []);
export async function saveSub(sub, prefs, pers) {
  const p = {};
  for (const t of TOPICS) p[t] = !!(prefs && want(prefs, t));
  const tz = pers && typeof pers.tz === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(pers.tz) ? pers.tz : 'UTC';
  const me = { wish: clean(pers && pers.wish, 60), muts: clean(pers && pers.muts, 30), tz };
  await redis.hset(SUBS, { [subId(sub.endpoint)]: { sub, prefs: p, me, t: Date.now() } });
}

// Personal alerts: pick(me) returns a payload for that subscriber or null. Only subscribers who turned on "mine".
export async function sendPersonal(pick, origin) {
  if (!redis) return { sent: 0 };
  const v = await vapid();
  webpush.setVapidDetails(origin || 'https://brainrotdex.vercel.app', v.publicKey, v.privateKey);
  const all = (await redis.hgetall(SUBS)) || {};
  let sent = 0, matched = 0;
  for (const [id, s] of Object.entries(all)) {
    if (!s || !s.sub || !s.prefs || !s.prefs.mine || !s.me) continue;
    let payload = null; try { payload = pick(s.me); } catch {}
    if (!payload) continue;
    matched++;
    try { await webpush.sendNotification(s.sub, JSON.stringify({ ...payload, topic: 'mine' }), { TTL: 3600, urgency: 'high' }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await redis.hdel(SUBS, id); }
  }
  return { sent, matched };
}

// When a wanted mutation comes up on a newly posted Admin Machine roll.
export function rollPick(r) {
  return (me) => {
    if (!me.muts || !me.muts.includes(r.event)) return null;
    let when = '';
    try { when = new Intl.DateTimeFormat('en-US', { timeZone: me.tz || 'UTC', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(r.at)); } catch {}
    const tr = r.traits && r.traits.length ? ` · ${r.traits.length} trait${r.traits.length > 1 ? 's' : ''}` : '';
    return { title: `${r.event} is coming: Admin Machine ${when}`, body: `A mutation you're hunting. ${r.boost || ''}${tr}`.trim(), tag: 'mine-' + r.at, url: '/#plan' };
  };
}

// When a wishlist brainrot is named in a post (Admin Abuse lineup, rare spawns).
export function wishPick(text, title, url) {
  const t = String(text || '').toLowerCase();
  return (me) => {
    const hit = (me.wish || []).filter((n) => n.length >= 4 && t.includes(n.toLowerCase()));
    if (!hit.length) return null;
    return { title: `${hit[0]}${hit.length > 1 ? ` +${hit.length - 1}` : ''} from your wishlist`, body: String(title || '').slice(0, 160), tag: 'wish-' + hit[0].slice(0, 20), url: url || '/#events' };
  };
}

export const dropSub = (endpoint) => redis.hdel(SUBS, subId(endpoint));

// Send one notification to every subscriber who opted into `topic`.
export async function sendAll(topic, payload, origin) {
  if (!redis) return { sent: 0 };
  const v = await vapid();
  webpush.setVapidDetails(origin || 'https://brainrotdex.vercel.app', v.publicKey, v.privateKey);
  const all = (await redis.hgetall(SUBS)) || {};
  const body = JSON.stringify({ ...payload, topic });
  let sent = 0, dropped = 0;
  const errors = [];
  const entries = Object.entries(all).filter(([, s]) => s && s.sub && s.prefs && want(s.prefs, topic));
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
