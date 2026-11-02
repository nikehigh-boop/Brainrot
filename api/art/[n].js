// Brainrot art stored on the site (Discord and marketplace image links expire).
//   GET  /api/art/<slug>            -> the image (cached for a year; the feed links add ?v=<hash>)
//   POST /api/art/<slug>  (admin)   -> {name, data: base64 webp/png, src} stores it and links it in the feed's art map
//   ?kind=snd on either: the brainrot's sound instead ({name, data: base64 mp3/wav}); linked in the feed's snd map
//   ?kind=clip: an animated loop made with Runway from the brainrot's real art (owner only: stats key or admin token)
//     POST {name, prompt?}  -> starts a Runway image-to-video task (uses Runway credits)
//     GET  &check=1         -> checks the task; when done, stores the video and links it in the feed's clip map
//     GET                   -> the stored video
import crypto from 'crypto';
import RunwayML from '@runwayml/sdk';
import { redis } from '../../lib/redis.js';
import { isAdmin, isStatsKey } from '../../lib/admin.js';
import { env } from '../../lib/env.js';

const slugOf = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export default async function handler(req, res) {
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  const slug = slugOf(req.query.n);
  if (req.query.kind === 'clip') return clip(req, res);
  const snd = req.query.kind === 'snd';
  const KEY = (snd ? 'snd:' : 'art:') + slug;
  if (!slug) return res.status(400).json({ error: 'missing name' });
  try {
    if (req.method === 'GET') {
      const a = await redis.get(KEY);
      if (!a || !a.b64) return res.status(404).json({ error: snd ? 'no sound' : 'no art' });
      res.setHeader('Content-Type', a.type || 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(Buffer.from(a.b64, 'base64'));
    }
    if (req.method === 'POST') {
      if (!isAdmin(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const name = String(body.name || '').trim();
      const b64 = String(body.data || '').replace(/^data:image\/\w+;base64,/, '');
      const type = snd ? (/wav/i.test(body.type || '') ? 'audio/wav' : 'audio/mpeg') : /png$/i.test(body.type || '') ? 'image/png' : 'image/webp';
      if (!name || !b64) return res.status(400).json({ error: 'send {name, data}' });
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 500 || buf.length > 600 * 1024) return res.status(400).json({ error: `file must be 0.5–600 KB (got ${buf.length} bytes)` });
      const v = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
      await redis.set(KEY, { b64, type, name, src: String(body.src || '').slice(0, 300), at: new Date().toISOString() });
      const url = snd ? `/api/art/${slug}?kind=snd&v=${v}` : `/api/art/${slug}?v=${v}`;
      const feed = (await redis.get('feed:live')) || {};
      if (snd) feed.snd = { ...(feed.snd || {}), [name]: url };
      else feed.art = { ...(feed.art || {}), [name]: url };
      await redis.set('feed:live', feed);
      return res.status(200).json({ ok: true, name, url, bytes: buf.length });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}

// ---- Runway clips ----
const CHUNK = 700 * 1024; // stored in pieces so each Redis write stays small
const owner = (req) => { const a = req.headers.authorization; try { return isAdmin(a) || isStatsKey(a); } catch { return false; } };
const DEFAULT_PROMPT = 'The character stands in place and idles: slow breathing, shifts its weight, glances left and right, small expressive gesture. Soft rim light pulses gently. Camera completely still, locked-off framing, the dark background does not move. Smooth, subtle motion that loops cleanly.';

async function clip(req, res) {
  const slug = slugOf(req.query.n);
  if (!slug) return res.status(400).json({ error: 'missing name' });
  const META = 'clip:' + slug;
  try {
    if (req.method === 'GET' && !req.query.check) {
      const m = await redis.get(META);
      if (!m || !m.n) return res.status(404).json({ error: 'no clip' });
      const parts = await Promise.all(Array.from({ length: m.n }, (_, i) => redis.get(`${META}:${i}`)));
      const buf = Buffer.concat(parts.map((p) => Buffer.from(String(p || ''), 'base64')));
      res.setHeader('Content-Type', m.type || 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Accept-Ranges', 'bytes');
      const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (r) {
        const start = r[1] ? +r[1] : 0, end = r[2] ? Math.min(+r[2], buf.length - 1) : buf.length - 1;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
        return res.status(206).send(buf.subarray(start, end + 1));
      }
      return res.status(200).send(buf);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!owner(req)) return res.status(401).json({ error: 'owner key needed' });
    const key = env('RUNWAYML_API_SECRET');
    if (!key) return res.status(503).json({ error: 'RUNWAYML_API_SECRET is not set in Vercel' });
    const client = new RunwayML({ apiKey: key });
    const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'send {name}' });
      // Prefer a prepared square frame (/clipsrc/<slug>.png), else the brainrot's art.
      let img = `${origin}/clipsrc/${slug}.png`;
      if (!(await fetch(img, { method: 'HEAD' })).ok) {
        const feed = (await redis.get('feed:live')) || {};
        const a = feed.art && feed.art[name];
        if (!a) return res.status(400).json({ error: 'no art for that brainrot yet (add /clipsrc/' + slug + '.png)' });
        img = /^https?:/.test(a) ? a : origin + a;
      }
      const prompt = String(body.prompt || DEFAULT_PROMPT).slice(0, 1000);
      const task = await client.imageToVideo.create({ model: 'gen4_turbo', promptImage: img, promptText: prompt, ratio: '960:960', duration: 5 });
      await redis.set(`clipjob:${slug}`, { id: task.id, name, at: new Date().toISOString(), credits: task.estimatedCost && task.estimatedCost.credits, img }, { ex: 86400 });
      return res.status(200).json({ ok: true, task: task.id, credits: task.estimatedCost && task.estimatedCost.credits });
    }
    if (req.method === 'GET' && req.query.check) {
      const job = await redis.get(`clipjob:${slug}`);
      if (!job) { const m = await redis.get(META); return res.status(200).json(m ? { status: 'DONE', url: m.url } : { status: 'NONE' }); }
      const t = await client.tasks.retrieve(job.id);
      if (t.status === 'FAILED' || t.status === 'CANCELLED') { await redis.del(`clipjob:${slug}`); return res.status(200).json({ status: t.status, failureCode: t.failureCode || null, failure: t.failure || null }); }
      if (t.status !== 'SUCCEEDED') return res.status(200).json({ status: t.status, progress: t.progress ?? null });
      const vr = await fetch(t.output[0]);
      if (!vr.ok) return res.status(502).json({ error: 'could not download the clip from Runway', status: vr.status });
      const buf = Buffer.from(await vr.arrayBuffer());
      if (buf.length > 4.2 * 1024 * 1024) return res.status(200).json({ status: 'TOO_BIG', bytes: buf.length, output: t.output[0] });
      const b64 = buf.toString('base64'), n = Math.ceil(b64.length / CHUNK);
      for (let i = 0; i < n; i++) await redis.set(`${META}:${i}`, b64.slice(i * CHUNK, (i + 1) * CHUNK));
      const v = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
      const url = `/api/art/${slug}?kind=clip&v=${v}`;
      await redis.set(META, { n, bytes: buf.length, type: vr.headers.get('content-type') || 'video/mp4', name: job.name, task: job.id, at: new Date().toISOString(), url });
      const feed = (await redis.get('feed:live')) || {};
      feed.clip = { ...(feed.clip || {}), [job.name]: url };
      await redis.set('feed:live', feed);
      await redis.del(`clipjob:${slug}`);
      return res.status(200).json({ status: 'DONE', url, bytes: buf.length });
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
