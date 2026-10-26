// Private visitor counts, kept in the app's own Redis (no third-party tracking).
// POST {v, s, p}  -> counts one visit (v = random anonymous id kept in the browser)
// GET            -> totals + last 30 days. Needs: Authorization: Bearer <admin token>
import { redis } from '../lib/redis.js';
import { isAdmin } from '../lib/admin.js';

const day = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const TTL = 400 * 86400;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  try {
    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      const v = String((b && b.v) || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
      if (v.length < 8) return res.status(204).end();
      const p = ['ios', 'android', 'desktop'].includes(b.p) ? b.p : 'other';
      const d = day();
      const pipe = redis.pipeline();
      pipe.pfadd(`uv:${d}`, v); pipe.expire(`uv:${d}`, TTL);
      pipe.pfadd('uv:all', v);
      pipe.incr(`pv:${d}`); pipe.expire(`pv:${d}`, TTL);
      pipe.hincrby(`plat:${d}`, p, 1); pipe.expire(`plat:${d}`, TTL);
      if (b.s) pipe.pfadd('app:all', v);
      await pipe.exec();
      return res.status(204).end();
    }
    if (req.method === 'GET') {
      if (!isAdmin(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
      const days = [];
      for (let i = 0; i < 30; i++) days.push(day(new Date(Date.now() - i * 864e5)));
      const pipe = redis.pipeline();
      pipe.pfcount('uv:all'); pipe.pfcount('app:all'); pipe.scard('users:all'); pipe.hlen('push:subs');
      for (const d of days) { pipe.pfcount(`uv:${d}`); pipe.get(`pv:${d}`); pipe.hgetall(`plat:${d}`); }
      const r = await pipe.exec();
      const [visitors, installed, signedIn, pushDevices] = r;
      const daily = days.map((d, i) => ({ day: d, visitors: r[4 + i * 3] || 0, views: +(r[5 + i * 3] || 0), platforms: r[6 + i * 3] || {} }));
      return res.status(200).json({ since: '2026-10-26', visitors, installed, signedIn, pushDevices, daily });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
