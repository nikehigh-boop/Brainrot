// Discord interactions endpoint for the Brainrot Dex slash commands (/roll /waves /when /plan /price /brainrot /codes).
// Discord signs every request with Ed25519; the app's public key is read from Discord with the bot token and cached.
import { verify, createPublicKey } from 'node:crypto';
import { redis } from '../lib/redis.js';
import { env } from '../lib/env.js';
import { command, autocomplete } from '../lib/bot.js';

export const config = { api: { bodyParser: false } };

async function publicKey() {
  let k = redis && (await redis.get('discord:verifyKey'));
  if (k) return k;
  const token = env('DISCORD_BOT_TOKEN');
  if (!token) return null;
  const r = await fetch('https://discord.com/api/v10/applications/@me', { headers: { Authorization: `Bot ${token}` } });
  if (!r.ok) return null;
  k = (await r.json()).verify_key;
  if (k && redis) await redis.set('discord:verifyKey', k, { ex: 86400 });
  return k;
}

function ok(raw, sig, stamp, keyHex) {
  try {
    if (!/^[0-9a-f]{128}$/i.test(sig || '') || !stamp || !/^[0-9a-f]{64}$/i.test(keyHex || '')) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(keyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(stamp), raw]), key, Buffer.from(sig, 'hex'));
  } catch { return false; }
}

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const raw = await rawBody(req);
  if (!ok(raw, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], await publicKey())) return res.status(401).send('invalid request signature');
  let i; try { i = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('bad json'); }
  try {
    if (i.type === 1) return res.status(200).json({ type: 1 });
    if (i.type === 4) return res.status(200).json(await autocomplete(i));
    if (i.type === 2) return res.status(200).json(await command(i));
    return res.status(200).json({ type: 4, data: { content: 'Not supported.', flags: 64 } });
  } catch (e) {
    return res.status(200).json({ type: 4, data: { content: 'Something went wrong. Try again in a minute.', flags: 64 } });
  }
}
