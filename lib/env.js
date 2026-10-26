// Marketplace integrations may prefix their variables (e.g. brainrotdex_KV_REST_API_URL).
// Prefer the brainrotdex_ prefix, then an exact name, then any other prefix.
export function env(name) {
  const e = process.env;
  if (e['brainrotdex_' + name]) return e['brainrotdex_' + name];
  if (e[name]) return e[name];
  const k = Object.keys(e).sort().find((k) => k.endsWith('_' + name));
  return k ? e[k] : undefined;
}
