// Form controls and file/page views shared by every tool module.
import { h, icon, PDFDocument, loadLib, renderPage, fmtSize } from './core.js';

/* ---------- small form controls ---------- */

export const field = (label, ...control) => h('label', { class: 'f' }, h('span', { class: 'f__label' }, label), ...control);

export function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const draw = () => el.replaceChildren(...options.map(([v, label]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', onclick: () => { value = v; draw(); onChange(v); } }, label)));
  draw();
  return el;
}

export function choiceCards(options, value, onChange) {
  const el = h('div', { class: 'choices' });
  const draw = () => el.replaceChildren(...options.map(([v, title, sub]) =>
    h('button', { type: 'button', class: 'choice' + (v === value ? ' on' : ''), onclick: () => { value = v; draw(); onChange(v); } },
      h('strong', {}, title), sub && h('span', {}, sub))));
  draw();
  return el;
}

export const check = (label, checked, onChange) =>
  h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), h('span', {}, label));

export function slider(min, max, step, value, fmt, onInput) {
  const out = h('output', {}, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value, oninput: (e) => { out.textContent = fmt(+e.target.value); onInput(+e.target.value); } });
  return h('div', { class: 'slider' }, input, out);
}

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- shared views ---------- */

// One card per PDF, with its first page. Used by tools that take whole files.
// The one file a single-file tool works on, large and centred.
export function fileHero(doc) {
  const canvas = h('canvas', { class: 'thumb' });
  renderPage(doc.js, 0, 220, { canvas }).catch(() => {});
  return h('div', { class: 'hero-file' },
    h('div', { class: 'hero-file__page' }, canvas),
    h('strong', { title: doc.name }, doc.name),
    h('span', {}, `${doc.pages} page${doc.pages > 1 ? 's' : ''} · ${fmtSize(doc.size)}`));
}

// A compact line for the file, for sidebars.
export function fileRow(doc) {
  const canvas = h('canvas', { class: 'thumb' });
  renderPage(doc.js, 0, 44, { canvas }).catch(() => {});
  return h('div', { class: 'file-row' }, h('div', { class: 'file-row__page' }, canvas),
    h('div', { class: 'card__meta' }, h('strong', { title: doc.name }, doc.name), h('span', {}, `${doc.pages} page${doc.pages > 1 ? 's' : ''} · ${fmtSize(doc.size)}`)));
}

export const GROUP_COLORS = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];

export function fileCard(doc, extra = []) {
  const canvas = h('canvas', { class: 'thumb' });
  renderPage(doc.js, 0, 150, { canvas }).catch(() => {});
  return h('div', { class: 'card' },
    h('div', { class: 'card__page' }, canvas),
    h('div', { class: 'card__meta' }, h('strong', { title: doc.name }, doc.name), h('span', {}, `${doc.pages} page${doc.pages > 1 ? 's' : ''} · ${fmtSize(doc.size)}`)),
    ...extra);
}

// A grid of page thumbnails. `decorate(cell, index)` adds per-page controls.
export function pageGrid(doc, decorate) {
  const grid = h('div', { class: 'pages' });
  for (let i = 0; i < doc.pages; i++) {
    const canvas = h('canvas', { class: 'thumb' });
    renderPage(doc.js, i, 130, { canvas }).catch(() => {});
    const cell = h('div', { class: 'pg', 'data-i': i }, h('div', { class: 'pg__page' }, canvas), h('span', { class: 'pg__num' }, String(i + 1)));
    decorate?.(cell, i);
    grid.append(cell);
  }
  return grid;
}

export const pdfOut = (name, bytes) => ({ name, bytes, type: 'application/pdf' });

// Renders a single page of `bytes` into `target` for live previews.
export async function previewInto(target, bytes, width) {
  const js = await window.pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const canvas = await renderPage(js, 0, width, { lazy: false });
  js.destroy();
  target.replaceChildren(canvas);
}

// Copies one page into a new document so a preview only redraws that page.
export async function singlePage(lib, index) {
  const out = await PDFDocument.create();
  const [p] = await out.copyPages(lib, [index]);
  out.addPage(p);
  return out;
}

export function previewPane(doc, build) {
  // build(lib, pageIndexes, isPreview) stamps onto lib's pages.
  let index = 0;
  let src = null;
  const holder = h('div', { class: 'preview__page' });
  const label = h('span', {});
  const prev = h('button', { class: 'iconbtn', 'aria-label': 'Previous page', onclick: () => go(-1) }, icon('back'));
  const next = h('button', { class: 'iconbtn flip', 'aria-label': 'Next page', onclick: () => go(1) }, icon('back'));
  const pane = h('div', { class: 'preview' }, holder, h('div', { class: 'preview__nav' }, prev, label, next));
  const go = (d) => { index = Math.min(doc.pages - 1, Math.max(0, index + d)); refresh(); };
  const refresh = debounce(async () => {
    label.textContent = `Page ${index + 1} of ${doc.pages}`;
    prev.disabled = index === 0; next.disabled = index === doc.pages - 1;
    try {
      src ||= await loadLib(doc);
      const one = await singlePage(src, index);
      await build(one, [0], index);
      await previewInto(holder, await one.save(), Math.min(560, pane.clientWidth || 520));
    } catch (err) { console.error(err); }
  }, 200);
  pane.refresh = refresh;
  refresh();
  return pane;
}
