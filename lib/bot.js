// Discord slash commands for Brainrot Dex: data lookups and replies (read-only, uses the same feed as the app).
import { redis } from './redis.js';

export const SITE = 'https://brainrotdex.vercel.app';
export const CMDV = '3'; // bump to re-register commands

const MUT = { type: 3, name: 'mutation', description: 'Mutation, like Gothic or Heaven', required: true, autocomplete: true };
const BR = { type: 3, name: 'brainrot', description: 'Brainrot name', required: true, autocomplete: true };
const ANY = { integration_types: [0, 1], contexts: [0, 1, 2] };
export const COMMANDS = [
  { name: 'roll', description: 'Next Admin Machine rolls: event, boost and traits', ...ANY },
  { name: 'waves', description: 'The event wave live now and the next ones', ...ANY },
  { name: 'when', description: 'When a mutation comes up next (waves and Admin Machine rolls)', options: [MUT], ...ANY },
  { name: 'plan', description: 'Best times to play in the next 24 hours', ...ANY },
  { name: 'price', description: 'Typical market price of a brainrot (Gameflip sales)', options: [BR, { ...MUT, required: false, description: 'Only this mutation' }], ...ANY },
  { name: 'brainrot', description: 'Look up a brainrot: rarity, income, cost and where it comes from', options: [BR], ...ANY },
  { name: 'codes', description: 'Latest Steal the Brainrot codes', ...ANY },
];

const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const ts = (t, f = 't') => `<t:${Math.floor(t / 1000)}:${f}>`;
const money = (n) => { if (n == null) return '?'; const u = [[1e15, 'Qa'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']].find(([v]) => n >= v); return u ? `$${+(n / u[0]).toFixed(n / u[0] < 10 ? 2 : 1)}${u[1]}` : `$${n}`; };
const usd = (n) => '$' + (n >= 100 ? Math.round(n) : n.toFixed(2).replace(/\.00$/, ''));
const hex = (c) => parseInt((String(c || '').match(/#([0-9a-f]{6})/i) || [0, 'c5f33c'])[1], 16);
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

// Dex data (names, rarities, mutations, art), read from the live app page and cached for 6 hours.
export async function dex() {
  const c = redis && (await redis.get('bot:dex'));
  if (c && c.at > Date.now() - 6 * 36e5) return c;
  const html = await (await fetch(SITE + '/', { headers: { 'User-Agent': 'BrainrotDex bot' } })).text();
  const m = html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return c || { brainrots: [], mutations: [], img: {} };
  const d = JSON.parse(m[1]);
  const out = {
    at: Date.now(),
    brainrots: d.brainrots.map((b) => ({ n: b.name, d: b.display || b.name, r: b.r, i: b.income, c: b.cost, s: (b.src || []).slice(0, 3), a: b.added || null })),
    mutations: d.mutations.map((x) => ({ n: x.name, m: x.m, c: x.c })),
    rar: Object.fromEntries((Array.isArray(d.rarities) ? d.rarities : []).map((v) => [v.id, { l: v.label || v.id, c: v.c }])),
    img: d.img || {},
  };
  if (redis) await redis.set('bot:dex', out);
  return out;
}

const feed = async () => (redis && (await redis.get('feed:live'))) || {};
// Dex plus brainrots added through the feed since the last app build.
async function dexAll(f) {
  const D = await dex(), have = new Set(D.brainrots.map((b) => b.n));
  const extra = (f.brainrots || []).filter((b) => b && b.name && !have.has(b.name)).map((b) => ({ n: b.name, d: b.display || b.name, r: b.r, i: b.income, c: b.cost, s: (b.src || []).slice(0, 3), a: b.added || null }));
  return extra.length ? { ...D, brainrots: [...D.brainrots, ...extra] } : D;
}

// Every wave time in [from, to), from each wave's UTC slots plus its confirmed next time.
function waveTimes(f, from, to) {
  const out = [];
  for (const e of f.events || []) for (const w of e.waves || []) {
    const seen = new Set();
    const add = (t) => { if (t + 15 * 6e4 > from && t < to && ![...seen].some((x) => Math.abs(x - t) < 6e4)) { seen.add(t); out.push({ t, w }); } };
    const n = w.next ? Date.parse(w.next) : NaN; if (!isNaN(n)) add(n);
    const d = new Date(from);
    for (let k = -1; k <= 3; k++) for (const hm of w.slots || []) { const [h, mi] = hm.split(':').map(Number); add(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + k, h, mi)); }
  }
  return out.sort((a, b) => a.t - b.t);
}
const rolls = (f) => ((f.live && f.live.admin && f.live.admin.rolls) || []).map((r) => ({ ...r, t: Date.parse(r.at) })).filter((r) => !isNaN(r.t)).sort((a, b) => a.t - b.t);
function boostScore(b) { b = String(b || ''); if (/8\s*[×x]\s*Gem/i.test(b)) return 6; const l = b.match(/\+?(\d+)\s*Luck Level/i); if (l) return Math.min(6, +l[1] / 10); if (/4\s*[×x]\s*Cash/i.test(b)) return 3; const c = b.match(/(\d+)\s*[×x]\s*Luck Conveyor/i); if (c) return 1 + +c[1] / 2; return b ? 1 : 0; }

const footer = { text: 'Brainrot Dex · brainrotdex.vercel.app' };
const btn = (label, path) => ({ type: 1, components: [{ type: 2, style: 5, label, url: SITE + path }] });
const reply = (embeds, link) => ({ type: 4, data: { embeds: [].concat(embeds).map((e) => ({ color: 0xc5f33c, footer, ...e })), components: link ? [btn(...link)] : [], allowed_mentions: { parse: [] } } });
const oops = (text) => ({ type: 4, data: { content: text, flags: 64 } });

function findBr(D, q) { const k = norm(q); return D.brainrots.find((b) => norm(b.n) === k) || D.brainrots.find((b) => norm(b.d) === k) || D.brainrots.find((b) => norm(b.n).startsWith(k)) || D.brainrots.find((b) => norm(b.n).includes(k)); }
function findMut(D, q) { const k = norm(q); return D.mutations.find((m) => norm(m.n) === k) || D.mutations.find((m) => norm(m.n).startsWith(k)); }
const opt = (i, name) => ((i.data && i.data.options) || []).find((o) => o.name === name);

export async function autocomplete(i) {
  const D = await dexAll(await feed());
  const o = ((i.data && i.data.options) || []).find((x) => x.focused) || {};
  const k = norm(o.value);
  const list = o.name === 'mutation' ? D.mutations.map((m) => m.n) : D.brainrots.map((b) => b.n);
  const hits = (k ? list.filter((n) => norm(n).startsWith(k)).concat(list.filter((n) => !norm(n).startsWith(k) && norm(n).includes(k))) : list).slice(0, 25);
  return { type: 8, data: { choices: hits.map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })) } };
}

export async function command(i) {
  const name = i.data && i.data.name, now = Date.now();
  const f = await feed(), D = await dexAll(f);
  const mx = (n) => { const m = D.mutations.find((x) => x.n === n); return m ? m.m : null; };
  const rollLine = (r) => `${ts(r.t)} (${ts(r.t, 'R')}) · **${r.event}**${mx(r.event) ? ` ×${mx(r.event)}` : ''} · ${r.boost || 'no boost'}${r.traits && r.traits.length ? ` · ${r.traits.join(', ')}` : ''}`;

  if (name === 'roll') {
    const R = rolls(f), up = R.filter((r) => r.t > now - 5 * 6e4).slice(0, 3), last = R.filter((r) => r.t <= now - 5 * 6e4).pop();
    if (!up.length && !last) return oops('No Admin Machine rolls posted yet. Check back soon.');
    const first = up[0];
    return reply({ title: '🎰 Admin Machine', color: hex((D.mutations.find((m) => m.n === (first || last).event) || {}).c),
      description: (up.length ? up.map(rollLine).join('\n') : 'Next roll not posted yet.') + (last ? `\n\n**Last roll:** ${rollLine(last)}` : '') + (first && first.spawn ? `\n\nBrainrot spawns ${Math.floor(first.spawn / 60)}m ${first.spawn % 60}s after the roll.` : '') }, ['Open Play Now', '/#plan']);
  }
  if (name === 'waves') {
    const W = waveTimes(f, now, now + 6 * 36e5), live = W.filter((x) => x.t <= now), next = W.filter((x) => x.t > now).slice(0, 6);
    if (!W.length) return oops('No event waves are running right now.');
    const ln = (x) => `${x.w.icon || '•'} **${x.w.name}** ${ts(x.t)} (${ts(x.t, 'R')}) · ×${mx(x.w.mut) || '?'} ${x.w.mut}`;
    return reply({ title: '🌊 Event waves', description: (live.length ? `**Live now**\n${live.map(ln).join('\n')}\n\n` : '') + `**Up next**\n${next.map(ln).join('\n')}` }, ['All event times', '/#events']);
  }
  if (name === 'when') {
    const m = findMut(D, (opt(i, 'mutation') || {}).value);
    if (!m) return oops("I don't know that mutation. Pick one from the list.");
    const W = waveTimes(f, now, now + 48 * 36e5).filter((x) => x.w.mut === m.n).slice(0, 3), R = rolls(f).filter((r) => r.t > now && r.event === m.n);
    const lines = [...W.map((x) => `${x.w.icon || '🌊'} ${x.w.name} wave ${ts(x.t, 'f')} (${ts(x.t, 'R')})`), ...R.map((r) => `🎰 Admin Machine ${ts(r.t, 'f')} (${ts(r.t, 'R')}) · ${r.boost || ''}`)];
    return reply({ title: `When is ${m.n}? (×${m.m})`, color: hex(m.c), description: lines.length ? lines.join('\n') : `${m.n} isn't on any wave or posted Admin Machine roll in the next 48 hours. Admin Machine rolls are posted a few hours ahead, so check again later.` }, ['Play Now planner', '/#plan']);
  }
  if (name === 'plan') {
    const M = [];
    for (const x of waveTimes(f, now, now + 24 * 36e5)) M.push({ t: x.t, s: mx(x.w.mut) || 1, l: `${x.w.icon || '🌊'} ${x.w.name} wave · ×${mx(x.w.mut) || '?'}` });
    for (const r of rolls(f).filter((r) => r.t > now - 30 * 6e4 && r.t < now + 24 * 36e5)) M.push({ t: r.t, s: (mx(r.event) || 4) + boostScore(r.boost) * 2 + (r.traits || []).length * 0.8 + 4, l: `🎰 Admin Machine: **${r.event}** · ${r.boost || ''}${r.traits && r.traits.length ? ` · ${r.traits.length} traits` : ''}` });
    const best = M.sort((a, b) => b.s - a.s).slice(0, 5);
    if (!best.length) return oops('Nothing scheduled in the next 24 hours yet.');
    return reply({ title: '⭐ Best times to play (next 24h)', description: best.map((x, k) => `**${k + 1}.** ${ts(x.t)} (${ts(x.t, 'R')}) · ${x.l}`).join('\n') + '\n\nRanked by mutation multiplier, boost and traits. Times show in your time zone.' }, ['Full plan', '/#plan']);
  }
  if (name === 'brainrot' || name === 'price') {
    const b = findBr(D, (opt(i, 'brainrot') || {}).value);
    if (!b) return oops("I couldn't find that brainrot. Pick one from the list.");
    const slug = b.n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const art = (f.art && f.art[b.n]) || D.img[b.n];
    const thumb = art ? { url: (/^https?:/.test(art) ? '' : SITE) + art } : undefined;
    const rr = D.rar[b.r] || { l: b.r };
    if (name === 'brainrot') {
      return reply({ title: b.d, url: `${SITE}/#b-${slug}`, color: hex(rr.c), thumbnail: thumb,
        fields: [{ name: 'Rarity', value: String(rr.l || b.r || '?'), inline: true }, { name: 'Income', value: b.i != null ? money(b.i) + '/s' : '?', inline: true }, { name: 'Cost', value: b.c != null ? money(b.c) : '?', inline: true },
          ...(b.s.length ? [{ name: 'Where from', value: b.s.join(', ').slice(0, 200) }] : []), ...(b.a ? [{ name: 'Added', value: String(b.a), inline: true }] : [])] }, ['Open in the Dex', `/#b-${slug}`]);
    }
    const gf = (redis && (await redis.get('mkt:gf'))) || { items: [] };
    const mm = opt(i, 'mutation') ? findMut(D, opt(i, 'mutation').value) : null;
    let rows = gf.items.filter((x) => x.n === b.n);
    if (mm) rows = rows.filter((x) => x.m === mm.n);
    if (!rows.length) return reply({ title: `${b.d}${mm ? ' · ' + mm.n : ''}`, thumbnail: thumb, description: 'No recent Gameflip sales or listings found for this one.' }, ['Open in the Dex', `/#b-${slug}`]);
    const sold = rows.filter((x) => x.k === 'sold'), pts = rows.flatMap((x) => (x.k === 'sold' ? [x.p, x.p] : [x.p]));
    const by = {}; rows.forEach((x) => (by[x.m] = by[x.m] || []).push(x.p));
    const muts = Object.entries(by).map(([m, p]) => [m, median(p), p.length]).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return reply({ title: `${b.d}${mm ? ' · ' + mm.n : ''}: about ${usd(median(pts))}`, url: `${SITE}/#b-${slug}`, thumbnail: thumb,
      description: `${sold.length} sold, ${rows.length - sold.length} listed on Gameflip (sold prices count double).${!mm && muts.length > 1 ? '\n\n' + muts.map(([m, v, n]) => `**${m}** ${usd(v)} (${n})`).join(' · ') : ''}\n\n-# Unofficial reference only. Real-money trading breaks Epic's rules.` }, ['Market details', `/#b-${slug}`]);
  }
  if (name === 'codes') {
    const C = (f.codes || []).slice(0, 8);
    if (!C.length) return oops('No codes right now.');
    return reply({ title: '🎁 Latest codes', description: C.map((c) => `\`${c.code}\` · ${c.reward}${c.date ? ` · ${c.date}` : ''}`).join('\n') }, ['All codes', '/#codes']);
  }
  return oops('Unknown command.');
}
