// Schedules exact-time alerts with Upstash QStash.
import { redis } from './redis.js';
import { env } from './env.js';
import { eventMoments } from './alerts.js';

export const LEAD_MS = 10 * 60e3; // every "going live" alert fires 10 minutes early
const PRE_MS = LEAD_MS;

export function rollTimes(r) {
  const at = Date.parse(r.at);
  return { pre: at - PRE_MS, spawn: r.spawn != null && r.spawn * 1e3 > LEAD_MS + 2 * 60e3 ? at + r.spawn * 1e3 - LEAD_MS : null };
}

export async function scheduleRolls(rolls, origin) {
  const token = env('QSTASH_TOKEN');
  if (!token || !redis || !Array.isArray(rolls)) return { scheduled: 0, reason: token ? 'no rolls' : 'qstash not connected' };
  const base = (env('QSTASH_URL') || 'https://qstash.upstash.io').replace(/\/$/, '');
  const now = Date.now();
  let scheduled = 0;
  for (const r of rolls) {
    if (!r || !r.at || isNaN(Date.parse(r.at))) continue;
    const t = rollTimes(r);
    for (const [type, when] of [['pre', t.pre], ['spawn', t.spawn]]) {
      if (!when || when < now + 20e3 || when > now + 7 * 864e5) continue;
      const key = `sched:${type}:${r.at}:${Math.round(when / 1000)}`;
      if (!(await redis.set(key, 1, { nx: true, ex: 8 * 86400 }))) continue;
      const res = await fetch(`${base}/v2/publish/${origin}/api/notify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Upstash-Not-Before': String(Math.floor(when / 1000)), 'Upstash-Retries': '1' },
        body: JSON.stringify({ type, at: r.at }),
      });
      if (res.ok) scheduled++; else await redis.del(key);
    }
  }
  return { scheduled };
}

export async function scheduleEvents(events, origin) {
  const token = env('QSTASH_TOKEN');
  if (!token || !redis) return { scheduled: 0, reason: token ? 'no storage' : 'qstash not connected' };
  const base = (env('QSTASH_URL') || 'https://qstash.upstash.io').replace(/\/$/, '');
  const now = Date.now();
  let scheduled = 0;
  for (const m of eventMoments(events)) {
    if (m.due < now + 20e3 || m.due > now + 14 * 864e5) continue;
    const key = `sched:ev:${m.phase}:${m.title}:${Math.round(m.due / 1000)}`;
    if (!(await redis.set(key, 1, { nx: true, ex: 15 * 86400 }))) continue;
    const res = await fetch(`${base}/v2/publish/${origin}/api/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Upstash-Not-Before': String(Math.floor(m.due / 1000)), 'Upstash-Retries': '1' },
      body: JSON.stringify({ type: 'ev', title: m.title, phase: m.phase, at: m.at }),
    });
    if (res.ok) scheduled++; else await redis.del(key);
  }
  return { scheduled };
}
