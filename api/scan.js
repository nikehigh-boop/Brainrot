// Snap your base: reads a Steal the Brainrot screenshot and lists the brainrots in it, for the player to confirm.
// POST {image: base64 JPEG/PNG/WebP} -> {found: [{name, mutation, traits, count}]}
// Needs ANTHROPIC_API_KEY in the Vercel project. Limited to 12 scans per IP a day and 400 a day overall.
import { redis } from '../lib/redis.js';
import { env } from '../lib/env.js';
import { dexNames } from '../lib/gameflip.js';

export const config = { api: { bodyParser: { sizeLimit: '6mb' } }, maxDuration: 60 };
const TRAITS = ['Lightning', 'Frozen', 'Fireworks', 'Cupid', 'Wave', 'Glitch', 'Tung', 'Carps', 'Bats', 'Forest', 'Pumpkin', 'Birthday', 'Ghost', 'Skibidi'];
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function lists(origin) {
  let c = redis && (await redis.get('scan:names'));
  if (!c || c.at < Date.now() - 6 * 36e5) {
    const d = await dexNames(origin);
    const f = (redis && (await redis.get('feed:live'))) || {};
    const extra = (f.brainrots || []).map((b) => b && b.name).filter(Boolean);
    c = { at: Date.now(), names: [...new Set([...d.names, ...extra])], mutations: d.mutations };
    if (redis) await redis.set('scan:names', c);
  }
  return c;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = env('ANTHROPIC_API_KEY');
  if (req.method === 'GET') return res.status(200).json({ ready: !!key });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!key) return res.status(503).json({ error: 'Base scanning is not switched on yet.' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const m = String(b.image || '').match(/^(?:data:(image\/(?:jpeg|png|webp));base64,)?([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Send a JPEG, PNG or WebP screenshot.' });
  const data = m[2], type = m[1] || 'image/jpeg';
  if (data.length < 2000 || data.length > 5.5e6) return res.status(400).json({ error: 'That image is too small or too large.' });
  if (redis) {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown', day = new Date().toISOString().slice(0, 10);
    const [a, g] = await Promise.all([redis.incr(`scanlim:ip:${ip}:${day}`), redis.incr(`scanlim:all:${day}`)]);
    await Promise.all([redis.expire(`scanlim:ip:${ip}:${day}`, 90000), redis.expire(`scanlim:all:${day}`, 90000)]);
    if (a > 12) return res.status(429).json({ error: "That's 12 scans today. Try again tomorrow." });
    if (g > 400) return res.status(429).json({ error: 'Scanning is busy today. Try again tomorrow.' });
  }
  const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  const L = await lists(origin);
  const prompt = `This is a screenshot from Fortnite's "Steal the Brainrot". List every brainrot character you can identify in it. Each brainrot usually has a floating label with its name, its mutation (a coloured word such as Gold, Diamond, Rainbow, Gothic) and sometimes trait icons, plus its income per second.

Rules:
- Use ONLY names from this list (pick the closest match to the label text): ${L.names.join(' | ')}
- mutation must be one of: ${L.mutations.join(' | ')}. If there is no mutation word, use "Default".
- traits only from: ${TRAITS.join(' | ')}. Leave empty if unsure.
- If the same brainrot with the same mutation appears more than once, set count.
- Skip anything you cannot read with reasonable confidence.

Reply with JSON only, no other text: {"found":[{"name":"...","mutation":"...","traits":[],"count":1}]}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env('SCAN_MODEL') || 'claude-sonnet-5-5', max_tokens: 1500, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: type, data } }, { type: 'text', text: prompt }] }] }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const msg = String((e.error && e.error.message) || '');
    if (redis) await redis.set('scan:lastError', { at: new Date().toISOString(), status: r.status, type: e.error && e.error.type, msg: msg.slice(0, 300) }, { ex: 7 * 86400 });
    return res.status(502).json({ error: /credit balance/i.test(msg) ? 'The scanner is out of credit right now.' : 'The scanner is unavailable right now.', status: r.status, reason: (e.error && e.error.type) || null, detail: msg.slice(0, 200) });
  }
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  let out = []; try { out = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]).found || []; } catch {}
  const byN = new Map(L.names.map((n) => [norm(n), n])), byM = new Map(L.mutations.map((n) => [norm(n), n]));
  const found = [];
  for (const x of Array.isArray(out) ? out : []) {
    const name = byN.get(norm(x && x.name));
    if (!name) continue;
    found.push({ name, mutation: byM.get(norm(x.mutation)) || 'Default', traits: (Array.isArray(x.traits) ? x.traits : []).filter((t) => TRAITS.includes(t)).slice(0, 6), count: Math.max(1, Math.min(20, parseInt(x.count) || 1)) });
  }
  return res.status(200).json({ found: found.slice(0, 60) });
}
