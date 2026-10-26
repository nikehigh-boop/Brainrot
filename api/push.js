// Save (POST {sub, prefs}) or remove (DELETE {endpoint}) a browser's alert subscription.
import { redis } from '../lib/redis.js';
import { saveSub, dropSub } from '../lib/push.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  try {
    if (req.method === 'POST') {
      const sub = body.sub;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
        return res.status(400).json({ error: 'bad subscription' });
      if (JSON.stringify(sub).length > 2000) return res.status(413).json({ error: 'too large' });
      await saveSub({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }, body.prefs);
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (typeof body.endpoint !== 'string') return res.status(400).json({ error: 'send {endpoint}' });
      await dropSub(body.endpoint);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'storage error' });
  }
}
