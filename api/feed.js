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

// Public roll stats from every archived Admin Machine roll (only rolls on the game's fixed :30 slots).
const SLOTS = [4, 10, 16, 22];
export function archiveStats(h) {
  const rolls = [];
  for (const [k, v] of Object.entries(h || {})) {
    if (!k.startsWith('r|')) continue;
    const at = k.slice(2), d = new Date(at);
    if (isNaN(d) || !SLOTS.includes(d.getUTCHours()) || d.getUTCMinutes() !== 30 || d > Date.now() + 864e5) continue;
    let r; try { r = typeof v === 'string' ? JSON.parse(v) : v; } catch { continue; }
    if (!r || !r.event) continue;
    rolls.push({ at, event: String(r.event).replace(/^dia de muertos$/i, 'Día de Muertos'), boost: r.boost || '', traits: Array.isArray(r.traits) ? r.traits : [] });
  }
  rolls.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const past = rolls.filter((r) => Date.parse(r.at) <= Date.now());
  const tally = (pick) => { const m = {}; past.forEach((r, i) => [].concat(pick(r)).filter(Boolean).forEach((x) => { const o = (m[x] = m[x] || { name: x, n: 0, last: null, ago: 0 }); o.n++; o.last = r.at; o.ago = past.length - 1 - i; })); return Object.values(m).sort((a, b) => b.n - a.n); };
  const boostKind = (b) => /gem/i.test(b) ? '8× Gem Boost' : /luck level/i.test(b) ? (b.match(/\+?\d+\s*Luck Level/i) || [b])[0].replace(/^(?!\+)/, '+') : /cash/i.test(b) ? '4× Cash Multiplier' : /conveyor/i.test(b) ? (b.match(/\d+\s*[×x]\s*Luck Conveyor/i) || [b])[0] : b;
  const nTraits = past.reduce((a, r) => a + r.traits.length, 0);
  const bySlot = SLOTS.map((h) => ({ utc: h, n: past.filter((r) => new Date(r.at).getUTCHours() === h).length, events: tally((r) => (new Date(r.at).getUTCHours() === h ? r.event : null)).slice(0, 3).map((e) => e.name) }));
  let repeat = 0; for (let i = 1; i < past.length; i++) if (past[i].event === past[i - 1].event) repeat++;
  return {
    since: past[0]?.at || null, total: past.length, avgTraits: past.length ? Math.round((nTraits / past.length) * 10) / 10 : 0, repeatRate: past.length > 1 ? Math.round((repeat / (past.length - 1)) * 100) : 0,
    events: tally((r) => r.event), boosts: tally((r) => boostKind(r.boost)), traits: tally((r) => r.traits).slice(0, 20), slots: bySlot,
    recent: rolls.slice(-40).reverse(), updated: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (req.query && req.query.archive) { res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600'); return res.status(200).json(archiveStats((redis && (await redis.hgetall('hist:schedule'))) || {})); }
      if (req.query && req.query.hist && authorized(req)) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json((redis && (await redis.hgetall('hist:schedule'))) || {}); }
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
      if ((body.live || body.events) && !body.liveAt) doc.liveAt = new Date().toISOString(); // when live times were last refreshed
      await redis.set(KEY, doc);
      // Keep every Admin Machine roll and wave time ever posted, to look for a repeating schedule.
      try {
        const hist = {};
        for (const r of doc?.live?.admin?.rolls || []) if (r && r.at) hist['r|' + r.at] = JSON.stringify({ event: r.event, boost: r.boost, traits: r.traits, spawn: r.spawn });
        for (const e of doc?.events || []) for (const w of e?.waves || []) if (w && w.name && w.next) hist['w|' + w.name + '|' + w.next] = '1';
        if (Object.keys(hist).length) await redis.hset('hist:schedule', hist);
      } catch {}
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
