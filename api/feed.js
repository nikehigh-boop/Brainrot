// Live feed (Admin Machine rolls, events, codes, leaks).
// GET  -> the stored feed, or the bundled feed.json if nothing is stored yet.
// POST -> merge top-level fields into the stored feed. Needs: Authorization: Bearer <admin token>
import { redis } from '../lib/redis.js';
import { isAdmin } from '../lib/admin.js';
import { scheduleRolls, scheduleEvents } from '../lib/schedule.js';
import { diffAlerts } from '../lib/alerts.js';
import { sendAll } from '../lib/push.js';

const KEY = 'feed:live';

async function bundled(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const r = await fetch(`${proto}://${req.headers.host}/feed.json`);
  return r.ok ? r.json() : {};
}

const authorized = (req) => isAdmin(req.headers.authorization);

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const doc = (redis && (await redis.get(KEY))) || (await bundled(req));
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json(doc);
    }
    if (req.method === 'POST') {
      if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
      if (!redis) return res.status(503).json({ error: 'storage not configured' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'send a JSON object' });
      const prev = (await redis.get(KEY)) || (await bundled(req));
      const doc = { ...prev, ...body };
      await redis.set(KEY, doc);
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const origin = `${proto}://${req.headers.host}`;
      let alerts = [], schedule = null;
      try { schedule = await scheduleRolls(doc.live?.admin?.rolls, origin); } catch (e) { schedule = { error: String(e.message || e) }; }
      try { schedule = { ...(schedule || {}), events: await scheduleEvents(doc.events, origin) }; } catch (e) { schedule = { ...(schedule || {}), eventsError: String(e.message || e) }; }
      try { for (const [topic, msg] of diffAlerts(prev, doc)) alerts.push({ topic, ...(await sendAll(topic, msg, origin)) }); } catch (e) { alerts.push({ error: String(e.message || e) }); }
      return res.status(200).json({ ok: true, updated: Object.keys(body), schedule, alerts });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
