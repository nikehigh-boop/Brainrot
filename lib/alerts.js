// Builds alert messages from the live feed.
import { rollTimes } from './schedule.js';

const traits = (r) => (r.traits && r.traits.length ? ' · ' + r.traits.join(', ') : '');
const desc = (r) => [r.event && r.event + ' event', r.boost].filter(Boolean).join(' · ');

export function rollAlert(type, at, feed) {
  const rolls = feed?.live?.admin?.rolls || [];
  const r = rolls.find((x) => x.at === at);
  if (!r) return null;
  const t = rollTimes(r);
  const due = type === 'pre' ? t.pre : t.spawn;
  if (!due || Math.abs(Date.now() - due) > 3 * 60e3) return null; // stale schedule (times changed)
  const sp = r.spawn != null ? ` · brainrot spawns ${Math.floor(r.spawn / 60)}m ${String(r.spawn % 60).padStart(2, '0')}s after the roll` : '';
  if (type === 'pre') return { title: 'Admin Machine rolls in 10 min', body: desc(r) + traits(r) + sp, tag: 'am-' + at, url: '/#events' };
  return { title: 'Admin Machine brainrot spawns in 10 min', body: desc(r) + traits(r), tag: 'am-' + at, url: '/#events' };
}

// Alerts implied by a feed update: new codes, new brainrots, a new Admin Abuse lineup.
export function diffAlerts(prev, next) {
  const out = [];
  const oldCodes = new Set((prev?.codes || []).map((c) => String(c.code)));
  const newCodes = (next?.codes || []).filter((c) => c && c.code && !oldCodes.has(String(c.code)));
  if (prev && newCodes.length) out.push(['news', {
    title: newCodes.length === 1 ? `New code: ${newCodes[0].code}` : `${newCodes.length} new codes`,
    body: newCodes.slice(0, 4).map((c) => `${c.code} · ${c.reward}`).join('\n'), tag: 'codes', url: '/#codes' }]);
  const oldB = new Set((prev?.brainrots || []).map((b) => b.name));
  const newB = (next?.brainrots || []).filter((b) => b && b.name && !oldB.has(b.name));
  if (prev && newB.length) out.push(['news', {
    title: newB.length === 1 ? `New brainrot: ${newB[0].name}` : `${newB.length} new brainrots`,
    body: newB.slice(0, 4).map((b) => b.name + (b.r ? ` (${b.r})` : '')).join(', '), tag: 'brainrots', url: '/#dex' }]);
  if (prev) for (const e of newLiveEvents(prev, next).slice(0, 3)) out.push(['events', {
    title: `Now live: ${String(e.title).slice(0, 60)}`, body: String(e.when || e.body || '').slice(0, 200), tag: 'ev-' + String(e.title).slice(0, 20), url: '/#events' }]);
  const a = next?.abuseAlert;
  if (a && a.id && a.id !== prev?.abuseAlert?.id) out.push(['abuse', {
    title: String(a.title || 'Admin Abuse is live').slice(0, 80), body: String(a.body || '').slice(0, 300), tag: 'abuse-' + a.id, url: '/#events' }]);
  return out;
}

// Timed events (feed.events[] with start / end / next / nextEnd, ISO UTC).
const P = (x) => (x ? Date.parse(x) : NaN);
const LEAD = 10 * 60e3;
export const eventTopic = (title) => (/admin abuse/i.test(title) ? 'abuse' : / wave$/.test(title) ? 'waves' : 'events');
export function eventMoments(ev) {
  const out = [];
  for (const e of Array.isArray(ev) ? ev : []) {
    if (!e || !e.title || e.tag === 'Spawns') continue;
    if (Array.isArray(e.waves) && e.waves.length) {
      const d = new Date();
      for (const w of e.waves) {
        if (!w || !w.name) continue;
        const ts = new Set();
        const n = P(w.next); if (!isNaN(n)) ts.add(n);
        for (let k = 0; k <= 2; k++) for (const hm of Array.isArray(w.slots) ? w.slots : []) {
          const [h, m] = String(hm).split(':').map(Number);
          const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + k, h, m);
          if (!isNaN(t) && ![...ts].some((x) => Math.abs(x - t) < 6e4)) ts.add(t);
        }
        for (const t of ts) out.push({ title: `${w.name} wave`, phase: 'start', at: new Date(t).toISOString(), due: t - LEAD });
      }
      continue;
    }
    if (Array.isArray(e.daily) && e.daily.length) {
      const d = new Date();
      for (let k = 0; k <= 2; k++) for (const hm of e.daily) {
        const [h, m] = String(hm).split(':').map(Number);
        const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + k, h, m);
        if (!isNaN(t)) out.push({ title: String(e.title), phase: 'start', at: new Date(t).toISOString(), due: t - LEAD });
      }
      continue;
    }
    for (const [k, phase] of [['start', 'start'], ['next', 'start'], ['end', 'end'], ['nextEnd', 'end']]) {
      const t = P(e[k]);
      if (isNaN(t)) continue;
      out.push({ title: String(e.title), phase, at: new Date(t).toISOString(), due: phase === 'end' ? t - 60 * 60e3 : t - LEAD });
    }
  }
  return out;
}
export function eventAlert(title, phase, at, feed) {
  const m = eventMoments(feed?.events).find((x) => x.title === title && x.phase === phase && x.at === at);
  if (!m || Math.abs(Date.now() - m.due) > 3 * 60e3) return null;
  const e = feed.events.find((x) => x.title === title) || (/ wave$/.test(title) ? { when: 'From the official Steal the Brainrot event tracker' } : {});
  const body = String(e.when || e.body || '').slice(0, 200);
  return phase === 'start'
    ? { title: `${title} starts in 10 min`, body, tag: 'ev-' + title.slice(0, 20), url: '/#events' }
    : { title: `${title} ends in 1 hour`, body, tag: 'ev-' + title.slice(0, 20), url: '/#events' };
}
// Events that newly went live in a feed update.
export function newLiveEvents(prev, next) {
  const was = new Set((prev?.events || []).filter((e) => e && e.kind === 'live').map((e) => e.title));
  return (next?.events || []).filter((e) => e && e.title && e.kind === 'live' && e.tag !== 'Codes' && !(Array.isArray(e.waves) && e.waves.length) && !was.has(e.title) && !(P(e.start) > Date.now()));
}
