// Reads the STB channels your Discord server follows, through your own bot (REST only, no gateway).
//   GET ?status=1            -> which feed channels the bot can see            (admin token)
//   GET ?ch=info-leaks&n=30  -> recent posts from one channel, simplified      (admin token)
//   GET ?sync=1              -> parse new Admin Machine posts into feed rolls  (QStash schedule or admin token)
// Needs DISCORD_BOT_TOKEN. The bot only needs View Channels + Read Message History and the Message Content intent.
import { Receiver } from '@upstash/qstash';
import { redis } from '../lib/redis.js';
import { env } from '../lib/env.js';
import { isAdmin } from '../lib/admin.js';
import { scheduleRolls } from '../lib/schedule.js';

const API = 'https://discord.com/api/v10';
export const FEEDS = ['admin-machine', 'info-leaks', 'map-updates', 'brainrot-leaks', 'brainrot-updates', 'lirili-leaks'];

async function dget(path) {
  const token = env('DISCORD_BOT_TOKEN');
  if (!token) throw Object.assign(new Error('DISCORD_BOT_TOKEN is not set'), { code: 503 });
  const r = await fetch(API + path, { headers: { Authorization: `Bot ${token}`, 'User-Agent': 'BrainrotDex (https://brainrotdex.vercel.app, 1.0)' } });
  if (r.status === 429) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(`Discord rate limit, retry in ${j.retry_after || '?'}s`), { code: 429 }); }
  if (!r.ok) throw Object.assign(new Error(`Discord ${r.status} on ${path.split('?')[0]}`), { code: r.status });
  return r.json();
}

// Feed channel ids by name, found in the servers the bot is in (cached 1 hour).
async function channels(fresh) {
  if (!fresh && redis) { const c = await redis.get('discord:channels'); if (c) return c; }
  const map = {};
  for (const g of await dget('/users/@me/guilds')) {
    for (const ch of await dget(`/guilds/${g.id}/channels`)) {
      if (![0, 5].includes(ch.type)) continue; // text or announcement
      const name = String(ch.name || '').toLowerCase();
      const key = FEEDS.find((f) => name.includes(f));
      if (key && !map[key]) map[key] = { id: ch.id, name: ch.name, guild: g.name };
    }
  }
  if (redis) await redis.set('discord:channels', map, { ex: 3600 });
  return map;
}

const iso = (t) => new Date(+t * 1000).toISOString();
const plain = (s) => String(s || '')
  .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_, t) => iso(t))
  .replace(/<a?:(\w+):\d+>/g, ':$1:')
  .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, '')
  .trim();

function simplify(m) {
  const src = m.message_snapshots && m.message_snapshots[0] ? m.message_snapshots[0].message : m;
  return {
    id: m.id, at: m.timestamp, author: m.author && (m.author.global_name || m.author.username),
    content: plain(src.content),
    embeds: (src.embeds || []).map((e) => ({
      title: plain(e.title), description: plain(e.description),
      fields: (e.fields || []).map((f) => ({ name: plain(f.name), value: plain(f.value) })),
      footer: plain(e.footer && e.footer.text), image: (e.image && e.image.url) || undefined,
    })),
    attachments: (src.attachments || []).map((a) => a.url),
  };
}

// ---- Admin Machine posts -> rolls ----
const TRAITS = ['Lightning', 'Frozen', 'Fireworks', 'Cupid', 'Wave', 'Glitch', 'Tung', 'Carps', 'Bats', 'Forest', 'Pumpkin', 'Birthday', 'Ghost', 'Skibidi'];
const TRAIT_ALIAS = { tungtrait: 'Tung', randomwave: 'Wave', skibiditoilet: 'Skibidi', skibiditrait: 'Skibidi', firework: 'Fireworks', bat: 'Bats' };
function traitName(e) {
  const k = e.toLowerCase();
  if (TRAIT_ALIAS[k]) return TRAIT_ALIAS[k];
  return TRAITS.find((t) => t.toLowerCase() === k || t.toLowerCase() === k.replace(/trait$/, '')) || null;
}
export function parseRoll(text) {
  const t = String(text || '');
  const ts = t.match(/<t:(\d+)(?::[a-zA-Z])?>/);
  const ev = t.match(/(?:^|\n)\W*([A-Za-z][A-Za-z ]{1,24}?) Event\b/);
  if (!ts || !ev) return null;
  const traits = [...t.matchAll(/<a?:(\w+):\d+>/g)].map((m) => traitName(m[1])).filter(Boolean);
  const boostLine = t.split('\n').find((l) => /(Luck|Cash|Gem|Conveyor|Multiplier|Money)/i.test(l.replace(/<a?:\w+:\d+>/g, '')) && /\d/.test(l.replace(/<a?:\w+:\d+>|<t:\d+(?::\w)?>/g, '')));
  const boost = boostLine ? boostLine.replace(/<a?:\w+:\d+>/g, '').replace(/[*_`]/g, '').trim().replace(/(\d)x\b/gi, '$1×') : '';
  const sp = t.match(/after\s+(?:(\d+)\s*m)?\s*(\d+)\s*s/i);
  return { at: iso(ts[1]).replace('.000Z', 'Z'), event: ev[1].replace(/[*_`]/g, '').trim(), boost, traits: [...new Set(traits)], spawn: sp ? (+(sp[1] || 0)) * 60 + (+sp[2]) : null };
}
function rollsFrom(m) {
  const src = m.message_snapshots && m.message_snapshots[0] ? m.message_snapshots[0].message : m;
  const blocks = [];
  for (const e of src.embeds || []) blocks.push([e.title, e.description, ...(e.fields || []).map((f) => `${f.name}\n${f.value}`), e.footer && e.footer.text].filter(Boolean).join('\n'));
  if (!blocks.length && src.content) blocks.push(src.content);
  return blocks.map(parseRoll).filter(Boolean);
}

async function sync(origin) {
  const map = await channels();
  const ch = map['admin-machine'];
  if (!ch) return { ok: false, reason: 'no admin-machine channel found in the bot’s servers' };
  const msgs = await dget(`/channels/${ch.id}/messages?limit=6`);
  const found = msgs.flatMap(rollsFrom);
  if (!found.length) return { ok: true, found: 0 };
  const feed = (await redis.get('feed:live')) || {};
  const live = feed.live || { admin: { hours: [4, 10, 16, 22], minute: 30, rolls: [] } };
  live.admin = live.admin || { hours: [4, 10, 16, 22], minute: 30, rolls: [] };
  const byAt = new Map((live.admin.rolls || []).map((r) => [r.at, r]));
  let changed = 0;
  for (const r of found) {
    const old = byAt.get(r.at);
    const merged = { ...(old || {}), ...r, traits: r.traits.length ? r.traits : (old ? old.traits : []) };
    if (JSON.stringify(old) !== JSON.stringify(merged)) { byAt.set(r.at, merged); changed++; }
  }
  if (changed) {
    live.admin.rolls = [...byAt.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-12);
    live.updated = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date()) + ' ET';
    await redis.set('feed:live', { ...feed, live });
  }
  const schedule = changed ? await scheduleRolls(live.admin.rolls, origin).catch((e) => ({ error: String(e.message || e) })) : null;
  await redis.set('discord:lastSync', { at: new Date().toISOString(), found: found.length, changed });
  return { ok: true, found: found.length, changed, schedule };
}

async function qstashOk(req) {
  const cur = env('QSTASH_CURRENT_SIGNING_KEY'), nxt = env('QSTASH_NEXT_SIGNING_KEY');
  const sig = req.headers['upstash-signature'];
  if (!cur || !nxt || !sig) return false;
  const body = typeof req.body === 'string' ? req.body : req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '';
  try { return await new Receiver({ currentSigningKey: cur, nextSigningKey: nxt }).verify({ signature: sig, body }); } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!redis) return res.status(503).json({ error: 'storage not configured' });
  const admin = isAdmin(req.headers.authorization);
  const q = req.query || {};
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  try {
    if (q.sync) {
      if (!admin && !(await qstashOk(req))) return res.status(401).json({ error: 'unauthorized' });
      return res.status(200).json(await sync(origin));
    }
    if (!admin) return res.status(401).json({ error: 'unauthorized' });
    if (q.status) {
      const map = await channels(true);
      return res.status(200).json({ channels: map, missing: FEEDS.filter((f) => !map[f]), lastSync: await redis.get('discord:lastSync') });
    }
    if (q.ch) {
      const map = await channels();
      const ch = map[String(q.ch)];
      if (!ch) return res.status(404).json({ error: `no ${q.ch} channel`, available: Object.keys(map) });
      const n = Math.max(1, Math.min(100, parseInt(q.n, 10) || 30));
      const msgs = await dget(`/channels/${ch.id}/messages?limit=${n}`);
      return res.status(200).json({ channel: ch, messages: msgs.map(simplify) });
    }
    return res.status(400).json({ error: 'use ?status=1, ?ch=<name> or ?sync=1' });
  } catch (e) {
    return res.status(e.code && e.code >= 400 && e.code < 600 ? e.code : 500).json({ error: String(e.message || e) });
  }
}
