// A signed-in player's saved progress. GET -> {state}, PUT {state} -> {ok}
import { redis } from '../lib/redis.js';
import { userId } from '../lib/auth.js';
import { geo } from '../lib/geo.js';

const MAX = 200_000; // bytes

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  const uid = await userId(req);
  if (!uid) return res.status(401).json({ error: 'sign in first' });
  const key = `state:${uid}`;
  try { await Promise.all([redis.sadd('users:all', uid), redis.hset('user:geo', { [uid]: { ...geo(req), at: new Date().toISOString().slice(0, 10) } })]); } catch {}
  try {
    if (req.method === 'GET') return res.status(200).json({ state: (await redis.get(key)) ?? null });
    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const state = body && body.state;
      if (!state || typeof state !== 'object' || Array.isArray(state)) return res.status(400).json({ error: 'send {state:{...}}' });
      if (JSON.stringify(state).length > MAX) return res.status(413).json({ error: 'too large' });
      await redis.set(key, state);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'storage error' });
  }
}
