// Where a request comes from, using the location headers Vercel adds (country, state/region, city).
const clean = (s, n) => String(s || '').replace(/[^\p{L}\p{N} .,'()_/-]/gu, '').trim().slice(0, n);
export function geo(req) {
  const h = req.headers;
  const dec = (x) => { try { return decodeURIComponent(String(x || '')); } catch { return String(x || ''); } };
  const c = clean(h['x-vercel-ip-country'], 2).toUpperCase() || '??';
  const r = clean(h['x-vercel-ip-country-region'], 8).toUpperCase();
  const city = clean(dec(h['x-vercel-ip-city']), 40);
  return { c, r, city };
}
