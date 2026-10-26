// Called by QStash at the scheduled time (signed), or manually with the admin token.
import { Receiver } from '@upstash/qstash';
import { redis } from '../lib/redis.js';
import { env } from '../lib/env.js';
import { sendAll, TOPICS } from '../lib/push.js';
import { rollAlert, eventAlert, eventTopic } from '../lib/alerts.js';
import { isAdmin } from '../lib/admin.js';

export async function POST(request) {
  const raw = await request.text();
  const origin = new URL(request.url).origin;
  let ok = isAdmin(request.headers.get('authorization'));
  if (!ok) {
    const cur = env('QSTASH_CURRENT_SIGNING_KEY'), nxt = env('QSTASH_NEXT_SIGNING_KEY');
    const sig = request.headers.get('upstash-signature');
    if (cur && nxt && sig) {
      try { ok = await new Receiver({ currentSigningKey: cur, nextSigningKey: nxt }).verify({ signature: sig, body: raw }); } catch { ok = false; }
    }
  }
  if (!ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let msg;
  try { msg = JSON.parse(raw || '{}'); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }

  if (msg.type === 'pre' || msg.type === 'spawn') {
    const feed = redis && (await redis.get('feed:live'));
    const alert = feed && rollAlert(msg.type, msg.at, feed);
    if (!alert) return Response.json({ skipped: true });
    if (!(await redis.set(`sent:${msg.type}:${msg.at}`, 1, { nx: true, ex: 86400 }))) return Response.json({ duplicate: true });
    return Response.json(await sendAll(msg.type, alert, origin));
  }
  if (msg.type === 'ev') {
    const feed = redis && (await redis.get('feed:live'));
    const alert = feed && eventAlert(String(msg.title || ''), msg.phase, msg.at, feed);
    if (!alert) return Response.json({ skipped: true });
    if (!(await redis.set(`sent:ev:${msg.phase}:${msg.title}:${msg.at}`, 1, { nx: true, ex: 86400 }))) return Response.json({ duplicate: true });
    return Response.json(await sendAll(msg.phase === 'start' ? eventTopic(String(msg.title || '')) : 'events', alert, origin));
  }
  if (TOPICS.includes(msg.topic) && msg.title) {
    return Response.json(await sendAll(msg.topic, { title: String(msg.title).slice(0, 80), body: String(msg.body || '').slice(0, 300), tag: String(msg.tag || msg.topic), url: String(msg.url || '/') }, origin));
  }
  return Response.json({ error: 'unknown message' }, { status: 400 });
}
