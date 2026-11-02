// Brainrot art stored on the site (Discord and marketplace image links expire).
//   GET  /api/art/<slug>            -> the image (cached for a year; the feed links add ?v=<hash>)
//   POST /api/art/<slug>  (admin)   -> {name, data: base64 webp/png, src} stores it and links it in the feed's art map
import crypto from 'crypto';
import { redis } from '../../lib/redis.js';
import { isAdmin } from '../../lib/admin.js';

const slugOf = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export default async function handler(req, res) {
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  const slug = slugOf(req.query.n);
  if (!slug) return res.status(400).json({ error: 'missing name' });
  try {
    if (req.method === 'GET') {
      const a = await redis.get('art:' + slug);
      if (!a || !a.b64) return res.status(404).json({ error: 'no art' });
      res.setHeader('Content-Type', a.type || 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(Buffer.from(a.b64, 'base64'));
    }
    if (req.method === 'POST') {
      if (!isAdmin(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const name = String(body.name || '').trim();
      const b64 = String(body.data || '').replace(/^data:image\/\w+;base64,/, '');
      const type = /png$/i.test(body.type || '') ? 'image/png' : 'image/webp';
      if (!name || !b64) return res.status(400).json({ error: 'send {name, data}' });
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 500 || buf.length > 600 * 1024) return res.status(400).json({ error: `image must be 0.5–600 KB (got ${buf.length} bytes)` });
      const v = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
      await redis.set('art:' + slug, { b64, type, name, src: String(body.src || '').slice(0, 300), at: new Date().toISOString() });
      const url = `/api/art/${slug}?v=${v}`;
      const feed = (await redis.get('feed:live')) || {};
      feed.art = { ...(feed.art || {}), [name]: url };
      await redis.set('feed:live', feed);
      return res.status(200).json({ ok: true, name, url, bytes: buf.length });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
