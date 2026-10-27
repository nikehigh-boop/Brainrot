// Gameflip prices for Fortnite Steal the Brainrot, from Gameflip's public listing search (no key needed).
// Only keeps listings that are tagged Fortnite on Gameflip, say "Steal the Brainrot" (or STB),
// and don't mention another brainrot game (Go Up for Brainrots, Fight the Brainrot, Grow a Brainrot,
// Fruits vs Brainrots, Roblox's Steal a Brainrot...). Bundles and listings naming several brainrots are skipped.
const API = 'https://production-gameflip.fingershock.com/api/v1/listing';
const TERMS = ['steal the brainrot', 'stb', 'brainrot'];
const STATUSES = ['sold', 'onsale'];
const PAGES = 5;
const PER_NAME = 40;

export const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

const POS = /steal ?(the |a )?brain ?rots?|\bstb\b/;
const NEG = /go ?up|fight (the )?brain|\bftb\b|grow ?(a |the )?brain|fruits? vs|roblox|tsunami|\bmerge\b|\bsab\b/;
const BUNDLE = /\bbundl?e?s?\b|\bbundel\b|\bx ?[2-9]\b|\b[2-9] ?x\b|\baccounts?\b|base paint|\bcustom\b|\bdeal\b|\bseeds?\b|\ball \d\b|\blot\b|\bpack\b|\bcarry\b|\bservice\b|\bboost(ing)?\b/;
// Names players use for brainrots the Dex lists under another name, or not at all.
const NOT_DEX = /grande (lucky )?rot|lucky rot/;
const GENERIC = new Set('la el lo los il the de di dan et tung big boss sir king queen mini baby brainrot brainrots fortnite steal traits trait level'.split(' '));
const MUT_ALIAS = { halloowen: 'Halloween', haloween: 'Halloween', muertos: 'Día de Muertos', 'dia de muertos': 'Día de Muertos', 'ice and fire': 'Ice & Fire', 'ice fire': 'Ice & Fire', 'fire and ice': 'Ice & Fire', golden: 'Gold', diamonds: 'Diamond' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (w) => new RegExp('\\b' + esc(w) + '\\b');

export function makeMatcher(names, mutations) {
  const N = names.map((n) => ({ n, k: norm(n), re: word(norm(n)) }));
  const muts = mutations.filter((m) => m !== 'Default').map((m) => ({ m, re: word(norm(m)) }));
  const mutWords = new Set(muts.flatMap((m) => norm(m.m).split(' ')).concat(Object.keys(MUT_ALIAS).flatMap((k) => k.split(' '))));
  const count = new Map();
  N.forEach(({ k }) => new Set(k.split(' ')).forEach((t) => count.set(t, (count.get(t) || 0) + 1)));
  const token = new Map();
  N.forEach(({ n, k }) => k.split(' ').forEach((t) => { if (count.get(t) === 1 && t.length >= 6 && !GENERIC.has(t) && !mutWords.has(t) && !token.has(t)) token.set(t, n); }));
  const aliasRe = Object.entries(MUT_ALIAS).map(([k, v]) => [word(k), v]);

  function mutation(t) {
    for (const [re, v] of aliasRe) if (re.test(t)) return v;
    const m = muts.find((x) => x.re.test(t));
    return m ? m.m : 'Default';
  }
  function pick(src) {
    let full = N.filter((x) => x.re.test(src));
    full = full.filter((x) => !full.some((o) => o !== x && o.k.includes(x.k)));
    if (full.length === 1) return full[0].n;
    if (full.length > 1) return false;
    const part = new Set(src.split(' ').filter((w) => token.has(w)).map((w) => token.get(w)));
    if (part.size === 1) return [...part][0];
    return part.size > 1 ? false : null;
  }
  // -> {n, m} or null
  return function match(listing) {
    const title = norm(listing.name);
    const all = norm(`${listing.name || ''} ${listing.description || ''}`);
    if (listing.upc !== 'GFFORTNITE' || !POS.test(all) || NEG.test(all)) return null;
    if (BUNDLE.test(title) || NOT_DEX.test(title)) return null;
    for (const src of [title, all]) {
      const n = pick(src);
      if (n === false) return null;
      if (n) return { n, m: mutation(norm(`${listing.name || ''} ${(listing.description || '').slice(0, 300)}`)) };
    }
    return null;
  };
}

async function page(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'BrainrotDex (https://brainrotdex.vercel.app)' } });
  if (!r.ok) throw new Error(`Gameflip ${r.status}`);
  return r.json();
}
async function search(term, status) {
  const out = [];
  let url = `${API}?upc=GFFORTNITE&status=${status}&term=${encodeURIComponent(term)}&limit=100`;
  for (let i = 0; i < PAGES && url; i++) {
    const j = await page(url);
    if (j.status !== 'SUCCESS' || !Array.isArray(j.data)) break;
    out.push(...j.data);
    const n = j.next_page;
    url = n ? (/^https?:/.test(n) ? n : 'https://production-gameflip.fingershock.com' + n) : null;
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const slug = (s) => norm(s).replace(/ /g, '-').slice(0, 60) || 'item';

// Pulls, filters and matches. Returns {asof, scanned, kept, items:[{n,m,p,k:'sold'|'listed',id,s,at}]}
export async function pullGameflip(names, mutations) {
  const match = makeMatcher(names, mutations);
  const lists = await Promise.allSettled(STATUSES.flatMap((st) => TERMS.map((t) => search(t, st))));
  const seen = new Map();
  lists.forEach((r) => r.status === 'fulfilled' && r.value.forEach((l) => seen.set(l.id, l)));
  if (!seen.size) throw new Error(lists.find((r) => r.status === 'rejected')?.reason?.message || 'Gameflip returned nothing');
  const by = new Map(), dup = new Set();
  for (const l of seen.values()) {
    if (!['sold', 'onsale'].includes(l.status) || !(l.price >= 50 && l.price <= 200000)) continue;
    const hit = match(l);
    if (!hit) continue;
    const it = { n: hit.n, m: hit.m, p: l.price / 100, k: l.status === 'sold' ? 'sold' : 'listed', id: l.id, s: slug(l.name), at: String(l.updated || l.created || '').slice(0, 10) };
    // The same seller relisting the same item counts once.
    const key = `${l.owner}|${it.s}|${it.p}|${it.k}`;
    if (dup.has(key)) continue;
    dup.add(key);
    if (!by.has(hit.n)) by.set(hit.n, []);
    by.get(hit.n).push(it);
  }
  const items = [];
  for (const arr of by.values()) {
    const m0 = median(arr.map((x) => x.p));
    const ok = arr.length >= 4 ? arr.filter((x) => x.p <= m0 * 4 && x.p >= m0 / 4) : arr;
    ok.sort((a, b) => (a.k === b.k ? 0 : a.k === 'sold' ? -1 : 1) || b.at.localeCompare(a.at));
    items.push(...ok.slice(0, PER_NAME));
  }
  return { asof: new Date().toISOString(), scanned: seen.size, kept: items.length, brainrots: by.size, items };
}

// Dex names and mutations, read from the live app page so new brainrots are picked up automatically.
export async function dexNames(origin) {
  const r = await fetch(origin + '/', { headers: { 'User-Agent': 'BrainrotDex market sync' } });
  const html = await r.text();
  const m = html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('could not read Dex data');
  const d = JSON.parse(m[1]);
  return { names: d.brainrots.map((b) => b.name), mutations: d.mutations.map((x) => x.name) };
}
