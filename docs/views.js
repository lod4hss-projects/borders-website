import { coordinates, count, debounce, fill, paginate, run } from './sparql.js';

export function escapeHtml(text) {
  const node = document.createElement('div');
  node.textContent = text === undefined || text === null ? '' : String(text);
  return node.innerHTML;
}

function fail(element, error) {
  element.innerHTML =
    `<p class="error">${escapeHtml(error.message || String(error))}</p>`;
}

// the one place that decides where a resource IRI links to
function href(config, value) {
  if (!value) return null;
  if (config.resourcePrefix && value.startsWith(config.resourcePrefix)) {
    return `${config.cardPage}?uri=${encodeURIComponent(value)}`;
  }
  return /^https?:/.test(value) ? value : null;
}

function link(config, value, text) {
  const target = href(config, value);
  const label = escapeHtml(text || value);
  if (!target) return label;
  const external = !target.startsWith(config.cardPage);
  return `<a href="${escapeHtml(target)}"${external ? ' rel="noreferrer"' : ''}>${label}</a>`;
}

function range(page, size, total) {
  const first = total === 0 ? 0 : page * size + 1;
  return `${first}–${Math.min((page + 1) * size, total)} of ${total}`;
}

function pager(page, size, total) {
  const last = Math.max(0, Math.ceil(total / size) - 1);
  const button = (target, text, enabled) =>
    `<button data-page="${target}"${enabled ? '' : ' disabled'}>${text}</button>`;
  return [
    button(0, 'First', page > 0),
    button(page - 1, 'Previous', page > 0),
    `<span class="range">${range(page, size, total)}</span>`,
    button(page + 1, 'Next', page < last),
    button(last, 'Last', page < last),
  ].join('');
}

export function table(config, root) {
  const search = root.querySelector('[data-search]');
  const body = root.querySelector('[data-rows]');
  const foot = root.querySelector('[data-pager]');
  const state = { term: '', page: 0, total: 0 };

  function cell(row, column) {
    const value = row[column.var];
    if (value === undefined) return '';
    const shown = column.label_var ? row[column.label_var] || value : value;
    if (!column.link) return escapeHtml(shown);
    // a reference links to what it points at; any other linked column is the
    // way into the row's own entity, so it links to the subject. Linking a
    // literal to its own text produces no link at all.
    return link(config, column.is_ref ? value : row.s, shown);
  }

  function draw(rows) {
    const head = config.columns
      .map((c) => `<th>${escapeHtml(c.name)}</th>`).join('');
    const lines = rows.map((row) =>
      `<tr>${config.columns.map((c) => `<td>${cell(row, c)}</td>`).join('')}</tr>`);
    body.innerHTML = rows.length
      ? `<table><thead><tr>${head}</tr></thead><tbody>${lines.join('')}</tbody></table>`
      : '<p class="empty">No matches.</p>';
    foot.innerHTML = pager(state.page, config.pageSize, state.total);
  }

  async function load() {
    body.setAttribute('aria-busy', 'true');
    try {
      const params = config.search ? { search: { literal: state.term } } : {};
      // the total is a separate query, so the footer never claims a page
      // size is the whole result set
      state.total = await count(config.endpoint, fill(config.total, params));
      const rows = await run(config.endpoint, paginate(
        fill(config.rows, params),
        { limit: config.pageSize, offset: state.page * config.pageSize }));
      draw(rows);
    } catch (error) {
      fail(body, error);
      foot.innerHTML = '';
    } finally {
      body.removeAttribute('aria-busy');
    }
  }

  if (search) {
    search.addEventListener('input', debounce(() => {
      state.term = search.value.trim();
      state.page = 0;
      load();
    }, 300));
  }
  foot.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-page]');
    if (!target || target.disabled) return;
    state.page = Number(target.dataset.page);
    load();
  });
  load();
}

export function card(config, root) {
  const params = new URLSearchParams(window.location.search);
  const uri = params.get('uri');
  const header = root.querySelector('[data-header]');
  if (!uri) {
    fail(header, new Error('This page needs a ?uri= parameter naming a resource.'));
    return;
  }
  const bound = { uri: { iri: uri } };

  async function drawHeader() {
    const rows = await run(config.endpoint, fill(config.header, bound));
    const row = rows[0] || {};
    const names = config.classNames || {};
    const cls = names[row.class] || row.classLabel || row.class
      || 'Unknown class';
    header.innerHTML =
      `<h1>${escapeHtml(row.label || uri)}</h1>`
      + `<p class="subtle">${escapeHtml(cls)}</p>`
      + `<p class="subtle"><code>${escapeHtml(uri)}</code></p>`;
  }

  function panel(name, query, draw) {
    const box = root.querySelector(`[data-${name}]`);
    const foot = root.querySelector(`[data-${name}-pager]`);
    const state = { page: 0 };
    async function load() {
      try {
        // one extra row tells us whether a next page exists without a
        // second count query
        const rows = await run(config.endpoint, paginate(
          fill(query, bound),
          { limit: config.pageSize + 1, offset: state.page * config.pageSize }));
        const more = rows.length > config.pageSize;
        box.innerHTML = rows.length
          ? draw(rows.slice(0, config.pageSize))
          : '<p class="empty">Nothing here.</p>';
        foot.innerHTML =
          `<button data-page="${state.page - 1}"${state.page ? '' : ' disabled'}>Previous</button>`
          + `<span class="range">Page ${state.page + 1}</span>`
          + `<button data-page="${state.page + 1}"${more ? '' : ' disabled'}>Next</button>`;
      } catch (error) {
        fail(box, error);
        foot.innerHTML = '';
      }
    }
    foot.addEventListener('click', (event) => {
      const target = event.target.closest('button[data-page]');
      if (!target || target.disabled) return;
      state.page = Number(target.dataset.page);
      load();
    });
    load();
  }

  const outgoing = (rows) =>
    `<table><thead><tr><th>Property</th><th>Value</th></tr></thead><tbody>`
    + rows.map((r) => `<tr><td>${link(config, r.p, r.pLabel || r.p)}</td>`
      + `<td>${r.o$iri ? link(config, r.o, r.oLabel) : escapeHtml(r.o)}</td></tr>`).join('')
    + '</tbody></table>';

  // the incoming side shows the event node with its date and its other
  // participants, which is what makes a bare Membership readable
  const incoming = (rows) =>
    `<table><thead><tr><th>Subject</th><th>Property</th></tr></thead><tbody>`
    + rows.map((r) => {
      const when = r.when && r.when !== '-' ? ` <span class="subtle">(${escapeHtml(r.when)})</span>` : '';
      const sibs = r.siblings ? `<div class="subtle">${escapeHtml(r.siblings)}</div>` : '';
      return `<tr><td>${link(config, r.s, r.sName)}${when}${sibs}</td>`
        + `<td>${link(config, r.p, r.pLabel || r.p)}</td></tr>`;
    }).join('')
    + '</tbody></table>';

  drawHeader().catch((error) => fail(header, error));
  panel('outgoing', config.outgoing, outgoing);
  panel('incoming', config.incoming, incoming);
}

// Three is the all-pairs cap from the palette validation, so a fourth
// category folds into Other instead of inventing a hue. Colour follows the
// category, never its rank in the current result set.
const OTHER_LABEL = 'Other';

// Leaflet writes fill and stroke as SVG presentation attributes, and an
// attribute value is not CSS: var(--series-1) is never resolved there and the
// mark renders with an invalid paint. So the tokens are read off the document
// once and handed over as concrete colours. The fallbacks mirror base.css.
const FALLBACK = {
  '--series-1': '#2a78d6',
  '--series-2': '#eb6834',
  '--series-3': '#1baf7a',
  '--series-other': '#898781',
  '--chart-surface': '#ffffff',
};

export function palette() {
  let style = null;
  try {
    style = typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement) : null;
  } catch (error) {
    style = null;
  }
  const token = (name) => {
    const value = style ? (style.getPropertyValue(name) || '').trim() : '';
    return value || FALLBACK[name];
  };
  return {
    series: ['--series-1', '--series-2', '--series-3'].map(token),
    other: token('--series-other'),
    surface: token('--chart-surface'),
  };
}

function classify(values, series) {
  const tally = new Map();
  for (const value of values) {
    if (!value) continue;
    tally.set(value, (tally.get(value) || 0) + 1);
  }
  const ranked = [...tally.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const colours = new Map();
  ranked.slice(0, series.length).forEach(([name], i) => colours.set(name, series[i]));
  const folded = ranked.length > series.length;
  return { colours, folded };
}

function tooltip(root) {
  const node = document.createElement('div');
  node.className = 'tip';
  root.appendChild(node);
  return {
    show(html, x, y) {
      node.innerHTML = html;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.setAttribute('data-shown', '');
    },
    hide() { node.removeAttribute('data-shown'); },
  };
}

export function map(config, root) {
  const ink = palette();
  const canvas = root.querySelector('[data-map]');
  const legendBox = root.querySelector('[data-legend]');
  const note = root.querySelector('[data-note]');

  const view = L.map(canvas, { zoomControl: true }).setView([46.8, 8.2], 7);
  const tiles = config.tiles || {};
  L.tileLayer(tiles.url, {
    attribution: tiles.attribution || '',
    subdomains: tiles.subdomains || 'abc',
    maxZoom: tiles.maxZoom || 19,
  }).addTo(view);

  function radius(value, largest) {
    if (!largest || !value) return 5;
    return 4 + (Math.sqrt(value) / Math.sqrt(largest)) * 14;
  }

  (async () => {
    try {
      const rows = await run(config.endpoint, config.rows);
      const placed = [];
      for (const row of rows) {
        const point = coordinates(row[config.geoVar]);
        if (point) placed.push({ row, point });
      }
      const counted = config.countVar
        ? placed.map((p) => Number(p.row[config.countVar]) || 0) : [];
      const largest = counted.length ? Math.max(...counted) : 0;
      const kinds = config.colourLabelVar || config.colourVar;
      const { colours, folded } = classify(
        kinds ? placed.map((p) => p.row[kinds]) : [], ink.series);

      const bounds = [];
      for (const { row, point } of placed) {
        const kind = kinds ? row[kinds] : null;
        const colour = colours.size > 1
          ? (colours.get(kind) || ink.other) : ink.series[0];
        const value = config.countVar ? Number(row[config.countVar]) || 0 : 0;
        const marker = L.circleMarker([point.lat, point.long], {
          radius: radius(value, largest),
          fillColor: colour,
          color: ink.surface,
          weight: 2,
          opacity: 1,
          fillOpacity: 0.85,
        }).addTo(view);
        const target = href(config, row.s);
        marker.bindPopup(
          `<div class="marker-popup"><strong>${escapeHtml(row[config.labelVar])}</strong>`
          + (kind ? `<div>${escapeHtml(kind)}</div>` : '')
          + (config.countVar ? `<div class="count">${value}</div>`
            + `<div>${escapeHtml(config.countLabel || 'records')}</div>` : '')
          + (target ? `<p><a href="${escapeHtml(target)}">Open this record</a></p>` : '')
          + '</div>');
        bounds.push([point.lat, point.long]);
      }
      if (bounds.length) view.fitBounds(bounds, { padding: [30, 30] });

      // identity is never colour alone: every class is named here, which
      // also supplies the relief the palette validation asks for
      const entries = [...colours.entries()];
      if (folded) entries.push([OTHER_LABEL, ink.other]);
      // one class carries no information: a single-entry legend is noise,
      // and the marks fall back to slot 1
      legendBox.innerHTML = entries.length > 1
        ? entries.map(([name, colour]) =>
          `<li><span class="swatch" style="background:${colour}"></span>`
          + `${escapeHtml(name)}</li>`).join('')
        : '';

      const dropped = rows.length - placed.length;
      note.textContent =
        `${placed.length} of ${rows.length} records are on the map`
        + (dropped ? `; ${dropped} had coordinates that could not be read.` : '.');
    } catch (error) {
      fail(canvas, error);
    }
  })();
}

export function chart(config, root) {
  const box = root.querySelector('[data-chart]');
  const tableBox = root.querySelector('[data-table]');
  const tip = tooltip(root);

  function draw(rows) {
    const width = 760;
    const plot = 300;
    const left = 48;
    const bottom = 64;            // the band the x labels live in
    const head = 18;              // headroom so the peak's label is not clipped
    const height = plot + bottom;
    const largest = Math.max(...rows.map((r) => Number(r[config.countVar]) || 0), 1);
    const step = (width - left - 8) / rows.length;
    const gap = 2;                // surface gap between adjacent bars
    const ticks = 4;
    const peak = rows.reduce(
      (best, r) => (Number(r[config.countVar]) > Number(best[config.countVar]) ? r : best),
      rows[0]);

    const grid = Array.from({ length: ticks + 1 }, (_, i) => {
      const value = Math.round((largest / ticks) * i);
      const y = plot - (value / largest) * plot;
      return `<line class="grid" x1="${left}" y1="${y}" x2="${width}" y2="${y}"></line>`
        + `<text x="${left - 8}" y="${y + 4}" text-anchor="end">${value}</text>`;
    }).join('');

    const bars = rows.map((row, i) => {
      const value = Number(row[config.countVar]) || 0;
      const h = (value / largest) * (plot - head);
      const x = left + i * step;
      const w = Math.max(1, step - gap);
      const label = row[config.bucketVar];
      const isPeak = row === peak;
      return `<g>`
        + `<rect class="hit" x="${x}" y="0" width="${w}" height="${plot}"`
        + ` tabindex="0" role="img"`
        + ` aria-label="${escapeHtml(label)}: ${value}"`
        + ` data-label="${escapeHtml(label)}" data-value="${value}"></rect>`
        + `<rect class="bar" x="${x}" y="${plot - h}" width="${w}" height="${h}" rx="3"></rect>`
        + (isPeak ? `<text class="value" x="${x + w / 2}" y="${plot - h - 6}"`
          + ` text-anchor="middle">${value}</text>` : '')
        + `<text x="${x + w / 2}" y="${plot + 16}" text-anchor="end"`
        + ` transform="rotate(-40 ${x + w / 2} ${plot + 16})">${escapeHtml(label)}</text>`
        + `</g>`;
    }).join('');

    box.innerHTML =
      `<div class="chart"><svg viewBox="0 0 ${width} ${height}"`
      + ` preserveAspectRatio="xMinYMin meet" role="group"`
      + ` aria-label="${escapeHtml(config.title || 'chart')}">`
      + grid
      + `<line class="axis" x1="${left}" y1="${plot}" x2="${width}" y2="${plot}"></line>`
      + bars
      + '</svg></div>';

    // a value must never be reachable only by hovering, so the same numbers
    // are in a table view
    tableBox.innerHTML =
      '<details class="table-view"><summary>Table view</summary>'
      + '<table><thead><tr><th>Bucket</th><th class="num">Count</th></tr></thead><tbody>'
      + rows.map((r) => `<tr><td>${escapeHtml(r[config.bucketVar])}</td>`
        + `<td class="num">${escapeHtml(r[config.countVar])}</td></tr>`).join('')
      + '</tbody></table></details>';

    box.querySelectorAll('.hit').forEach((hit) => {
      const show = (event) => {
        const area = root.getBoundingClientRect();
        const spot = hit.getBoundingClientRect();
        tip.show(
          `<strong>${escapeHtml(hit.dataset.label)}</strong>: ${hit.dataset.value}`,
          spot.left - area.left + spot.width / 2,
          spot.top - area.top - 4);
      };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', tip.hide);
      hit.addEventListener('blur', tip.hide);
    });
  }

  (async () => {
    try {
      const rows = await run(config.endpoint, config.rows);
      if (!rows.length) {
        box.innerHTML = '<p class="empty">No data.</p>';
        return;
      }
      draw(rows);
    } catch (error) {
      fail(box, error);
    }
  })();
}

export { coordinates };
