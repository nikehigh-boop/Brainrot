// Private visitor counts, kept in the app's own Redis (no third-party tracking).
// POST {v, s, p, os, b, l, r} -> counts one visit (v = random anonymous id kept in the browser).
//   Demographics (country/state/city from Vercel's IP lookup, language, device, browser, referrer)
//   are counted once per visitor; time of day is counted per visit.
// GET -> totals, last 30 days, demographics and the signed-up players list (emails from Clerk).
//   Needs: Authorization: Bearer <admin token>
import { redis } from '../lib/redis.js';
import { isAdmin } from '../lib/admin.js';
import { geo } from '../lib/geo.js';

const day = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const hourET = () => +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date());
const TTL = 400 * 86400;
const clean = (s, n = 40) => String(s || '').replace(/[^\p{L}\p{N} .,'()_/-]/gu, '').trim().slice(0, n);
const pick = (v, ok, d = 'other') => (ok.includes(v) ? v : d);
const DEMO = ['country', 'region', 'city', 'lang', 'os', 'browser', 'ref', 'hour'];

async function clerkUsers() {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) return { error: 'CLERK_SECRET_KEY is not set' };
  const out = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const r = await fetch(`https://api.clerk.com/v1/users?limit=100&offset=${offset}&order_by=-created_at`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return { error: `Clerk ${r.status}`, users: out };
    const page = await r.json();
    const list = Array.isArray(page) ? page : page.data || [];
    for (const u of list) {
      const prim = (u.email_addresses || []).find((e) => e.id === u.primary_email_address_id) || (u.email_addresses || [])[0];
      out.push({
        id: u.id,
        email: prim ? prim.email_address : '',
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '',
        via: [...new Set((u.external_accounts || []).map((a) => String(a.provider || '').replace(/^oauth_/, '')))].join(', ') || (u.password_enabled ? 'password' : 'email code'),
        joined: u.created_at, lastSignIn: u.last_sign_in_at, lastActive: u.last_active_at || null,
      });
    }
    if (list.length < 100) break;
  }
  return { users: out };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  try {
    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      b = b || {};
      const v = String(b.v || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
      if (v.length < 8) return res.status(204).end();
      const p = pick(b.p, ['ios', 'android', 'desktop']);
      const d = day();
      const first = await redis.set(`seen:${v}`, 1, { nx: true, ex: TTL });
      const pipe = redis.pipeline();
      pipe.pfadd(`uv:${d}`, v); pipe.expire(`uv:${d}`, TTL);
      pipe.pfadd('uv:all', v);
      pipe.incr(`pv:${d}`); pipe.expire(`pv:${d}`, TTL);
      pipe.hincrby(`plat:${d}`, p, 1); pipe.expire(`plat:${d}`, TTL);
      pipe.hincrby('demo:hour', String(hourET()), 1);
      if (b.s) pipe.pfadd('app:all', v);
      if (first) {
        const g = geo(req);
        pipe.hincrby('demo:country', g.c, 1);
        if (g.r) pipe.hincrby('demo:region', `${g.c}-${g.r}`, 1);
        if (g.city) pipe.hincrby('demo:city', `${g.city}${g.r ? ', ' + g.r : ''}, ${g.c}`, 1);
        pipe.hincrby('demo:lang', clean(b.l, 12) || '??', 1);
        pipe.hincrby('demo:os', pick(b.os, ['iOS', 'iPadOS', 'Android', 'Windows', 'macOS', 'ChromeOS', 'Linux']), 1);
        pipe.hincrby('demo:browser', pick(b.b, ['Safari', 'Chrome', 'Edge', 'Firefox', 'Samsung', 'Opera', 'In-app']), 1);
        pipe.hincrby('demo:ref', clean(b.r, 40).toLowerCase() || 'direct', 1);
      }
      await pipe.exec();
      return res.status(204).end();
    }
    if (req.method === 'GET') {
      if (!isAdmin(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
      const days = [];
      for (let i = 0; i < 30; i++) days.push(day(new Date(Date.now() - i * 864e5)));
      const pipe = redis.pipeline();
      pipe.pfcount('uv:all'); pipe.pfcount('app:all'); pipe.scard('users:all'); pipe.hlen('push:subs'); pipe.hgetall('user:geo');
      for (const k of DEMO) pipe.hgetall(`demo:${k}`);
      for (const d of days) { pipe.pfcount(`uv:${d}`); pipe.get(`pv:${d}`); pipe.hgetall(`plat:${d}`); }
      const [r, cu] = await Promise.all([pipe.exec(), clerkUsers().catch((e) => ({ error: String(e.message || e) }))]);
      const [visitors, installed, signedIn, pushDevices, ugeo] = r;
      const demo = Object.fromEntries(DEMO.map((k, i) => [k, r[5 + i] || {}]));
      const o = 5 + DEMO.length;
      const daily = days.map((d, i) => ({ day: d, visitors: r[o + i * 3] || 0, views: +(r[o + 1 + i * 3] || 0), platforms: r[o + 2 + i * 3] || {} }));
      const users = (cu.users || []).map((u) => {
        let g = ugeo && ugeo[u.id];
        if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
        return { ...u, place: g ? [g.city, g.r, g.c].filter(Boolean).join(', ') : '' };
      });
      return res.status(200).json({ since: '2026-10-26', demoSince: '2026-10-27', visitors, installed, signedIn, pushDevices, daily, demo, users, usersError: cu.error || null });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
