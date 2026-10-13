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

// every "long lat" pair inside one ring of a WKT geometry
function vertices(text) {
  const out = [];
  const pair = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
  let found = pair.exec(text);
  while (found !== null) {
    const long = Number(found[1]);
    const lat = Number(found[2]);
    if (Math.abs(lat) <= 90 && Math.abs(long) <= 180) out.push([lat, long]);
    found = pair.exec(text);
  }
  // WKT closes a ring by repeating the first vertex; carrying the duplicate
  // would weight it twice in the fallback below
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first[0] === last[0] && first[1] === last[1]) out.pop();
  return out;
}

// The area centroid, by the shoelace formula -- not the mean vertex, which a
// long shape drags towards whichever end was drawn in more detail.
function centre(ring) {
  let twice = 0;
  let lat = 0;
  let long = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [latA, longA] = ring[i];
    const [latB, longB] = ring[(i + 1) % ring.length];
    const cross = (longA * latB) - (longB * latA);
    twice += cross;
    lat += (latA + latB) * cross;
    long += (longA + longB) * cross;
  }
  if (!twice) {
    // a ring enclosing no area at all, so there is nothing to weight by
    const sum = ring.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
    return { lat: sum[0] / ring.length, long: sum[1] / ring.length };
  }
  return { lat: lat / (3 * twice), long: long / (3 * twice) };
}

// A POLYGON is an extent, not a place: reading it as a point put the mark on
// its first corner, which for a bounding box is a spot nothing is at. The
// rings come back so the map can draw the shape, and the point is the
// centroid, which is what everything else -- colour, clustering, the popup --
// goes on treating as the mark's position.
export function geometry(text) {
  const inner = String(text || '').match(/\(([^()]*)\)/g) || [];
  const rings = inner.map(vertices).filter((ring) => ring.length >= 3);
  if (!rings.length) {
    const point = coordinates(text);
    return point ? { point, rings: null } : null;
  }
  return { point: centre(rings[0]), rings };
}
