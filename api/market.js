// Community market prices (USD), reported by players. No outside APIs.
//   GET                 -> { summary: { "<brainrot>": {count, median, low, high, updated} } }
//   GET ?n=<brainrot>   -> { name, reports: [{m, price, kind, at}], summary }
//   POST {n, m, price, kind, v}  -> adds one report (anonymous id v; 5 per id and 15 per IP a day)
//   DELETE ?n=<brainrot>&at=<iso>  (admin token) -> removes one report
//   GET ?gf=1           -> Gameflip Steal the Brainrot prices, refreshed daily
//   GET ?sync=gameflip  -> refresh them (Vercel cron, admin token, or anyone at most every 6 hours)
import { redis } from '../lib/redis.js';
import { isAdmin } from '../lib/admin.js';
import { env } from '../lib/env.js';
import { pullGameflip, dexNames } from '../lib/gameflip.js';

const KINDS = ['sold', 'bought', 'listed'];
const MAX_PER_NAME = 100;
const keyOf = (n) => 'mkt:' + n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const cleanName = (s) => String(s || '').trim().slice(0, 60);
const okName = (s) => /^[\p{L}\p{N} .,'&-]{2,60}$/u.test(s);

function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; }

// Sold/bought reports count fully, "listed" ones half; outliers (beyond 4× either side of the median) are ignored.
export function summarize(reports) {
  if (!reports.length) return null;
  let prices = reports.map((r) => r.price);
  if (prices.length >= 5) { const m0 = median(prices); prices = prices.filter((p) => p <= m0 * 4 && p >= m0 / 4); }
  const kept = reports.filter((r) => prices.includes(r.price));
  const weighted = kept.flatMap((r) => (r.kind === 'listed' ? [r.price] : [r.price, r.price]));
  return {
    count: reports.length,
    median: Math.round(median(weighted) * 100) / 100,
    low: Math.min(...prices), high: Math.max(...prices),
    updated: reports.reduce((t, r) => (r.at > t ? r.at : t), ''),
  };
}

async function syncGameflip(req) {
  const cron = env('CRON_SECRET');
  const auth = String(req.headers.authorization || '');
  const trusted = isAdmin(auth) || (cron && auth === `Bearer ${cron}`);
  if (!trusted && !(await redis.set('mkt:gf:lock', 1, { nx: true, ex: 6 * 3600 }))) return { ok: false, reason: 'refreshed recently' };
  const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  const { names, mutations } = await dexNames(origin);
  const gf = await pullGameflip(names, mutations);
  await redis.set('mkt:gf', gf);
  return { ok: true, scanned: gf.scanned, kept: gf.kept, brainrots: gf.brainrots };
}

async function readReports(n) { return ((await redis.lrange(keyOf(n), 0, MAX_PER_NAME - 1)) || []).map((x) => (typeof x === 'string' ? JSON.parse(x) : x)); }

export default async function handler(req, res) {
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  try {
    if (req.method === 'GET' && req.query && req.query.sync === 'gameflip') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(await syncGameflip(req));
    }
    if (req.method === 'GET' && req.query && req.query.gf) {
      res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
      return res.status(200).json((await redis.get('mkt:gf')) || { items: [] });
    }
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      const n = cleanName(req.query && req.query.n);
      if (n) { const reports = await readReports(n); return res.status(200).json({ name: n, reports, summary: summarize(reports) }); }
      return res.status(200).json({ summary: (await redis.hgetall('mkt:sum')) || {} });
    }
    if (req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      const n = cleanName(b && b.n), m = cleanName(b && b.m) || 'Default';
      const price = Math.round(Number(b && b.price) * 100) / 100;
      const kind = KINDS.includes(b && b.kind) ? b.kind : null;
      const v = String((b && b.v) || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
      if (!okName(n) || !okName(m) || !kind || !(price >= 0.5 && price <= 2000) || v.length < 8) return res.status(400).json({ error: 'Check the brainrot, price ($0.50 to $2,000) and type.' });
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const day = new Date().toISOString().slice(0, 10);
      const [byId, byIp] = await Promise.all([redis.incr(`mktlim:v:${v}:${day}`), redis.incr(`mktlim:ip:${ip}:${day}`)]);
      await Promise.all([redis.expire(`mktlim:v:${v}:${day}`, 90000), redis.expire(`mktlim:ip:${ip}:${day}`, 90000)]);
      if (byId > 5 || byIp > 15) return res.status(429).json({ error: 'Thanks! That’s the daily limit for price reports.' });
      const rep = { m, price, kind, at: new Date().toISOString(), v: v.slice(0, 8) };
      await redis.lpush(keyOf(n), JSON.stringify(rep));
      await redis.ltrim(keyOf(n), 0, MAX_PER_NAME - 1);
      const sum = summarize(await readReports(n));
      await redis.hset('mkt:sum', { [n]: sum });
      return res.status(200).json({ ok: true, summary: sum });
    }
    if (req.method === 'DELETE') {
      if (!isAdmin(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
      const n = cleanName(req.query && req.query.n), at = String((req.query && req.query.at) || '');
      const reports = await readReports(n);
      const keep = reports.filter((r) => r.at !== at);
      await redis.del(keyOf(n));
      if (keep.length) await redis.rpush(keyOf(n), ...keep.map((r) => JSON.stringify(r)));
      const sum = summarize(keep);
      if (sum) await redis.hset('mkt:sum', { [n]: sum }); else await redis.hdel('mkt:sum', n);
      return res.status(200).json({ ok: true, removed: reports.length - keep.length });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
