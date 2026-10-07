// The only module that talks to the endpoint, and the only place a value is
// put into a query. The escaping rules mirror pagegen/terms.py and
// sparkle.fill() exactly: a parameter is never concatenated into a query.

const ECHAR = {
  '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r',
  '\t': '\\t', '\b': '\\b', '\f': '\\f',
};
const ECHAR_RE = /[\\"\n\r\t\b\f]/g;
const BAD_IRI = /[\u0000- <>"{}|^`\\]/;
const TOKEN = /\{\{([a-z][a-z0-9_]*)\}\}/g;

export function escapeLiteral(value) {
  return String(value).replace(ECHAR_RE, (c) => ECHAR[c]);
}

export function literal(value) {
  return `"${escapeLiteral(value)}"`;
}

export function iri(value) {
  const text = String(value);
  const bad = text.match(BAD_IRI);
  if (bad) {
    throw new Error(
      `IRI contains ${JSON.stringify(bad[0])}, which IRIREF does not allow: ${text}`);
  }
  return `<${text}>`;
}

// params maps a token name to {literal: v} or {iri: v}; anything else throws
export function fill(query, params = {}) {
  const seen = new Set();
  const out = String(query).replace(TOKEN, (_, name) => {
    const given = params[name];
    if (given === undefined) {
      throw new Error(`query still needs the parameter ${name}`);
    }
    seen.add(name);
    if ('iri' in given) return iri(given.iri);
    if ('literal' in given) return literal(given.literal);
    throw new Error(`parameter ${name} must be {literal} or {iri}`);
  });
  return out;
}

export function paginate(query, { limit, offset } = {}) {
  let text = String(query);
  if (limit !== undefined) text += `\nLIMIT ${Number(limit) | 0}`;
  if (offset) text += `\nOFFSET ${Number(offset) | 0}`;
  return text;
}

export async function run(endpoint, query) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ query: String(query) }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`endpoint returned HTTP ${response.status}. ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  if (data.boolean !== undefined) return data.boolean;
  const bindings = data.results?.bindings;
  if (!bindings) throw new Error('endpoint returned no result bindings');
  return bindings.map((row) => {
    const flat = {};
    for (const [key, cell] of Object.entries(row)) {
      flat[key] = cell.value;
      if (cell.type === 'uri') flat[`${key}$iri`] = true;
    }
    return flat;
  });
}

export async function count(endpoint, query) {
  const rows = await run(endpoint, query);
  return rows.length ? Number(rows[0].n) : 0;
}

export function debounce(fn, ms = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// WKT POINT, "lat long", "long,lat" -- the data is a plain string and not
// always well formed, so every caller must handle null
export function coordinates(text) {
  if (!text) return null;
  const numbers = String(text).match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length < 2) return null;
  const [a, b] = numbers.slice(0, 2).map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // WKT is POINT(long lat); a bare pair is assumed to be long lat too
  const [long, lat] = [a, b];
  if (Math.abs(lat) > 90 || Math.abs(long) > 180) return null;
  return { lat, long };
}
