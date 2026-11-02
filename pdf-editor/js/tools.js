// Every tool: what it shows while you set it up, and what it does when you press its button.
import {
  h, icon, busy, toast, tick, PDFDocument, StandardFonts, rgb, degrees, loadLib, renderPage, fmtSize, baseName,
  parseRanges, pageFrame, boxAnchor, fontCanDraw, textAsPng, hexToRgb, imageForPdf, sortable, uid, pickFiles,
} from './core.js';
import { editorTool } from './editor.js';

export const CATEGORIES = [['organize', 'Organize'], ['optimize', 'Optimize'], ['convert', 'Convert'], ['edit', 'Edit'], ['security', 'Security']];

/* ---------- small form controls ---------- */

const field = (label, ...control) => h('label', { class: 'f' }, h('span', { class: 'f__label' }, label), ...control);

function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const draw = () => el.replaceChildren(...options.map(([v, label]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', onclick: () => { value = v; draw(); onChange(v); } }, label)));
  draw();
  return el;
}

function choiceCards(options, value, onChange) {
  const el = h('div', { class: 'choices' });
  const draw = () => el.replaceChildren(...options.map(([v, title, sub]) =>
    h('button', { type: 'button', class: 'choice' + (v === value ? ' on' : ''), onclick: () => { value = v; draw(); onChange(v); } },
      h('strong', {}, title), sub && h('span', {}, sub))));
  draw();
  return el;
}

const check = (label, checked, onChange) =>
  h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), h('span', {}, label));

function slider(min, max, step, value, fmt, onInput) {
  const out = h('output', {}, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value, oninput: (e) => { out.textContent = fmt(+e.target.value); onInput(+e.target.value); } });
  return h('div', { class: 'slider' }, input, out);
}

const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- shared views ---------- */

// One card per PDF, with its first page. Used by tools that take whole files.
// The one file a single-file tool works on, large and centred.
function fileHero(doc) {
  const canvas = h('canvas', { class: 'thumb' });
  renderPage(doc.js, 0, 220, { canvas }).catch(() => {});
  return h('div', { class: 'hero-file' },
    h('div', { class: 'hero-file__page' }, canvas),
    h('strong', { title: doc.name }, doc.name),
    h('span', {}, `${doc.pages} page${doc.pages > 1 ? 's' : ''} · ${fmtSize(doc.size)}`));
}

// A compact line for the file, for sidebars.
function fileRow(doc) {
  const canvas = h('canvas', { class: 'thumb' });
  renderPage(doc.js, 0, 44, { canvas }).catch(() => {});
  return h('div', { class: 'file-row' }, h('div', { class: 'file-row__page' }, canvas),
    h('div', { class: 'card__meta' }, h('strong', { title: doc.name }, doc.name), h('span', {}, `${doc.pages} page${doc.pages > 1 ? 's' : ''} · ${fmtSize(doc.size)}`)));
}

const GROUP_COLORS = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];

function fileCard(doc, extra = []) {
  const canvas = h('canvas', { class: 'thumb' });
  renderPage(doc.js, 0, 150, { canvas }).catch(() => {});
  return h('div', { class: 'card' },
    h('div', { class: 'card__page' }, canvas),
    h('div', { class: 'card__meta' }, h('strong', { title: doc.name }, doc.name), h('span', {}, `${doc.pages} page${doc.pages > 1 ? 's' : ''} · ${fmtSize(doc.size)}`)),
    ...extra);
}

// A grid of page thumbnails. `decorate(cell, index)` adds per-page controls.
function pageGrid(doc, decorate) {
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

const pdfOut = (name, bytes) => ({ name, bytes, type: 'application/pdf' });

// Renders a single page of `bytes` into `target` for live previews.
async function previewInto(target, bytes, width) {
  const js = await window.pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const canvas = await renderPage(js, 0, width, { lazy: false });
  js.destroy();
  target.replaceChildren(canvas);
}

// Copies one page into a new document so a preview only redraws that page.
async function singlePage(lib, index) {
  const out = await PDFDocument.create();
  const [p] = await out.copyPages(lib, [index]);
  out.addPage(p);
  return out;
}

function previewPane(doc, build) {
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

/* ---------- MERGE ---------- */

const merge = {
  id: 'merge', keywords: 'combine join', title: 'Merge PDF', icon: 'merge', color: '#3b82f6', cat: 'organize', multiple: true, action: 'Merge PDF',
  desc: 'Join several PDFs into one, in the order you want.',
  long: 'Put PDFs together in the order you want. Drag the cards to change the order.',
  setup(ctx) {
    const list = h('div', { class: 'cards' });
    const draw = () => {
      list.replaceChildren(...ctx.items.map((d) => {
        const card = fileCard(d, [
          h('button', { class: 'iconbtn card__x', 'aria-label': `Remove ${d.name}`, onclick: () => { ctx.items.splice(ctx.items.indexOf(d), 1); draw(); } }, icon('x')),
          h('span', { class: 'grip', title: 'Drag to reorder' }, icon('grip')),
        ]);
        card.dataset.id = d.uid ||= uid();
        return card;
      }), h('button', { class: 'card card--add', onclick: add }, icon('plus'), 'Add PDF'));
      ctx.action.disabled = ctx.items.length < 2;
      hint.textContent = ctx.items.length < 2 ? 'Add at least one more PDF.' : `${ctx.items.length} files, ${ctx.items.reduce((s, d) => s + d.pages, 0)} pages in total.`;
    };
    const add = async () => { ctx.items.push(...(await ctx.addMore())); draw(); };
    ctx.onDropMore = (more) => { ctx.items.push(...more); draw(); };
    sortable(list, (ids) => { ctx.items.sort((a, b) => ids.indexOf(a.uid) - ids.indexOf(b.uid)); });
    const hint = h('p', { class: 'muted' });
    ctx.main.append(list);
    ctx.side.append(
      h('p', {}, 'Files are joined from left to right. Drag a card to move it.'),
      h('button', { class: 'btn btn--ghost btn--block', onclick: () => { ctx.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); draw(); } }, 'Sort by name'),
      hint);
    draw();
  },
  async run(ctx) {
    const out = await PDFDocument.create();
    for (const [i, d] of ctx.items.entries()) {
      busy(`Merging ${i + 1} of ${ctx.items.length}…`);
      await tick();
      const src = await loadLib(d);
      (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
    }
    return { files: [pdfOut('merged.pdf', await out.save())], title: 'Your PDFs are merged', note: `${ctx.items.length} files, ${out.getPageCount()} pages.` };
  },
};

/* ---------- SPLIT ---------- */

const split = {
  id: 'split', keywords: 'extract separate cut', title: 'Split PDF', icon: 'split', color: '#ec4899', cat: 'organize', action: 'Split PDF', wide: true,
  desc: 'Take pages out, or cut a PDF into several files.',
  long: 'Cut a PDF into several files by page ranges, one file per page, or pick the pages to keep.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { mode: 'ranges', ranges: doc.pages > 1 ? `1-${Math.ceil(doc.pages / 2)}, ${Math.ceil(doc.pages / 2) + 1}-${doc.pages}` : '1', picked: new Set(), joinRanges: false };
    if (doc.pages === 2) s.ranges = '1, 2';
    const grid = pageGrid(doc, (cell, i) => {
      cell.append(h('span', { class: 'pg__tick' }, icon('check')));
      cell.addEventListener('click', () => {
        if (s.mode !== 'pick') return;
        s.picked.has(i) ? s.picked.delete(i) : s.picked.add(i);
        paint();
      });
    });
    const rangeInput = h('input', { class: 'field', value: s.ranges, oninput: (e) => { s.ranges = e.target.value; paint(); } });
    const rangeHelp = h('p', { class: 'muted small' });
    const opts = h('div', {});
    const paint = () => {
      grid.classList.toggle('pickable', s.mode === 'pick');
      let groups = [];
      let err = '';
      if (s.mode === 'ranges') {
        try { groups = s.ranges.split(',').map((g) => g.trim()).filter(Boolean).map((g) => parseRanges(g, doc.pages)); } catch (e) { err = e.message; }
        rangeHelp.textContent = err || `${groups.length} file${groups.length === 1 ? '' : 's'}: ` + s.ranges.split(',').map((g) => g.trim()).filter(Boolean).join(' · ');
        rangeHelp.classList.toggle('bad', !!err);
      }
      const inSet = new Set(s.mode === 'ranges' ? groups.flat() : s.mode === 'pick' ? s.picked : []);
      grid.querySelectorAll('.pg').forEach((c) => {
        const i = +c.dataset.i;
        c.classList.toggle('on', s.mode === 'every' || inSet.has(i));
        const gi = groups.findIndex((g) => g.includes(i));
        c.style.setProperty('--g', gi < 0 ? '' : GROUP_COLORS[gi % GROUP_COLORS.length]);
        c.dataset.group = gi < 0 || s.mode !== 'ranges' ? '' : `File ${gi + 1}`;
      });
      ctx.action.disabled = (s.mode === 'ranges' && (!!err || !groups.length)) || (s.mode === 'pick' && !s.picked.size);
      if (s.mode === 'pick') opts.querySelector('.muted').textContent = s.picked.size ? `${s.picked.size} page${s.picked.size > 1 ? 's' : ''} selected.` : 'Click the pages you want to keep.';
    };
    const drawOpts = () => {
      if (s.mode === 'ranges') opts.replaceChildren(
        field('Page ranges, one file per range', rangeInput), rangeHelp,
        check('Put all ranges in one PDF', s.joinRanges, (v) => (s.joinRanges = v)));
      else if (s.mode === 'every') opts.replaceChildren(h('p', { class: 'muted' }, `Every page becomes its own PDF: ${doc.pages} files, saved together in a ZIP.`));
      else opts.replaceChildren(h('p', { class: 'muted' }),
        h('div', { class: 'row2' },
          h('button', { class: 'btn btn--ghost', onclick: () => { for (let i = 0; i < doc.pages; i++) s.picked.add(i); paint(); } }, 'Select all'),
          h('button', { class: 'btn btn--ghost', onclick: () => { s.picked.clear(); paint(); } }, 'Clear')));
      paint();
    };
    ctx.main.append(grid);
    ctx.side.append(
      fileRow(doc),
      segmented([['ranges', 'Ranges'], ['every', 'Each page'], ['pick', 'Pick pages']], s.mode, (m) => { s.mode = m; drawOpts(); }),
      opts);
    drawOpts();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    const src = await loadLib(doc);
    const base = baseName(doc.name);
    const make = async (indexes) => {
      const out = await PDFDocument.create();
      (await out.copyPages(src, indexes)).forEach((p) => out.addPage(p));
      return out.save();
    };
    const label = (ix) => (ix.length === 1 ? `${ix[0] + 1}` : `${ix[0] + 1}-${ix[ix.length - 1] + 1}`);
    let groups;
    if (s.mode === 'every') groups = src.getPageIndices().map((i) => [i]);
    else if (s.mode === 'pick') groups = [[...s.picked].sort((a, b) => a - b)];
    else {
      groups = s.ranges.split(',').map((g) => g.trim()).filter(Boolean).map((g) => parseRanges(g, doc.pages));
      if (s.joinRanges) groups = [groups.flat()];
    }
    const files = [];
    for (const [i, g] of groups.entries()) {
      busy(`Making file ${i + 1} of ${groups.length}…`);
      await tick();
      files.push(pdfOut(`${base}-${s.mode === 'pick' ? 'selected' : 'pages-' + label(g)}.pdf`, await make(g)));
    }
    return { files, zipName: `${base}-split.zip`, title: files.length > 1 ? `Split into ${files.length} files` : 'Your pages are ready' };
  },
};

/* ---------- ORGANIZE + ROTATE ---------- */

function pagesTool({ id, title, icon: ic, color, desc, long, action, reorder }) {
  return {
    id, title, icon: ic, color, desc, long, action, cat: 'organize', wide: true,
    setup(ctx) {
      // One entry per page in the output: which file, which page, extra turn.
      const docs = ctx.items;
      let pages = [];
      const addDoc = (d) => { for (let i = 0; i < d.pages; i++) pages.push({ d, i, rot: 0, id: uid() }); };
      docs.forEach(addDoc);
      ctx.state = { get pages() { return pages; }, docs };
      const grid = h('div', { class: 'pages pages--edit' });
      const cells = new Map();
      const cellFor = (p) => {
        if (cells.has(p.id)) return cells.get(p.id);
        const canvas = h('canvas', { class: 'thumb' });
        renderPage(p.d.js, p.i, 130, { canvas }).catch(() => {});
        const turn = (by) => { p.rot = (p.rot + by + 360) % 360; canvas.style.transform = `rotate(${p.rot}deg)`; };
        const cell = h('div', { class: 'pg', 'data-id': p.id },
          h('div', { class: 'pg__page' }, canvas),
          h('span', { class: 'pg__num' }),
          h('div', { class: 'pg__tools' },
            h('button', { class: 'iconbtn', title: 'Rotate left', 'aria-label': 'Rotate left', onclick: () => turn(-90) }, icon('rotateLeft')),
            h('button', { class: 'iconbtn', title: 'Rotate right', 'aria-label': 'Rotate right', onclick: () => turn(90) }, icon('rotate')),
            reorder && h('button', { class: 'iconbtn', title: 'Delete page', 'aria-label': 'Delete page', onclick: () => { pages = pages.filter((x) => x !== p); draw(); } }, icon('trash'))),
          reorder && h('span', { class: 'grip', title: 'Drag to move' }, icon('grip')));
        if (!reorder) cell.addEventListener('click', (e) => { if (!e.target.closest('button')) turn(90); });
        cell.turn = turn;
        cells.set(p.id, cell);
        return cell;
      };
      const count = h('p', { class: 'muted' });
      const draw = () => {
        grid.replaceChildren(...pages.map(cellFor));
        grid.querySelectorAll('.pg__num').forEach((n, k) => (n.textContent = String(k + 1)));
        count.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
        ctx.action.disabled = !pages.length;
      };
      if (reorder) sortable(grid, (ids) => { pages.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); draw(); });
      ctx.main.append(grid);
      ctx.side.append(
        h('p', {}, reorder ? 'Drag pages to change their order. Use the buttons on a page to turn or delete it.' : 'Click a page to turn it, or turn them all at once.'),
        h('div', { class: 'row2' },
          h('button', { class: 'btn btn--ghost', onclick: () => pages.forEach((p) => cellFor(p).turn(-90)) }, icon('rotateLeft'), 'All left'),
          h('button', { class: 'btn btn--ghost', onclick: () => pages.forEach((p) => cellFor(p).turn(90)) }, icon('rotate'), 'All right')),
        reorder && h('button', { class: 'btn btn--ghost btn--block', onclick: async () => { const more = await ctx.addMore(); more.forEach((d) => { docs.push(d); addDoc(d); }); draw(); } }, icon('plus'), 'Add pages from another PDF'),
        reorder && h('button', { class: 'btn btn--ghost btn--block', onclick: () => { pages = []; cells.forEach((c) => c.querySelector('canvas').style.transform = ''); docs.forEach(addDoc); cells.clear(); draw(); } }, 'Reset'),
        count);
      draw();
    },
    async run(ctx) {
      const { pages, docs } = ctx.state;
      const libs = new Map();
      for (const d of docs) libs.set(d, await loadLib(d));
      const first = docs[0];
      // Untouched page order and only rotations: change the file in place,
      // which keeps its bookmarks, links and form fields.
      const inPlace = docs.length === 1 && pages.length === first.pages && pages.every((p, k) => p.i === k);
      let out;
      if (inPlace) {
        out = libs.get(first);
        out.getPages().forEach((pg, k) => pages[k].rot && pg.setRotation(degrees((pg.getRotation().angle + pages[k].rot) % 360)));
      } else {
        out = await PDFDocument.create();
        for (const p of pages) {
          const [pg] = await out.copyPages(libs.get(p.d), [p.i]);
          if (p.rot) pg.setRotation(degrees((pg.getRotation().angle + p.rot) % 360));
          out.addPage(pg);
        }
      }
      return { files: [pdfOut(`${baseName(first.name)}-${id === 'rotate' ? 'rotated' : 'organized'}.pdf`, await out.save())] };
    },
  };
}

const organize = pagesTool({
  id: 'organize', title: 'Organize PDF', icon: 'organize', color: '#4f6ef7', action: 'Save PDF', reorder: true,
  desc: 'Reorder, delete and rotate pages, or add pages from another PDF.',
});
const rotate = pagesTool({
  id: 'rotate', title: 'Rotate PDF', icon: 'rotate', color: '#8b5cf6', action: 'Rotate PDF', reorder: false,
  desc: 'Turn some pages or the whole PDF the right way up.',
});

/* ---------- COMPRESS ---------- */

const LEVELS = {
  low: { maxSide: 2400, quality: 0.82 },
  medium: { maxSide: 1600, quality: 0.68 },
  high: { maxSide: 1100, quality: 0.5 },
};

const compress = {
  id: 'compress', keywords: 'reduce shrink size smaller', title: 'Compress PDF', icon: 'compress', color: '#fb923c', cat: 'optimize', action: 'Compress PDF', busyText: 'Compressing…',
  desc: 'Make a PDF smaller while keeping it readable.',
  long: 'Shrink the photos and scans inside a PDF. Text stays sharp and selectable.',
  setup(ctx) {
    ctx.state = { level: 'medium' };
    ctx.main.append(fileHero(ctx.items[0]));
    ctx.side.append(choiceCards([
      ['low', 'Less compression', 'Best quality, smaller saving'],
      ['medium', 'Recommended', 'Good quality, good saving'],
      ['high', 'Extreme', 'Smallest file, lower image quality'],
    ], 'medium', (v) => (ctx.state.level = v)));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const lib = await loadLib(doc);
    const { done, total } = await shrinkImages(lib, LEVELS[ctx.state.level], (k, n) => busy(`Compressing image ${k} of ${n}…`));
    busy('Saving…');
    await tick();
    const bytes = await lib.save({ useObjectStreams: true });
    const before = doc.size;
    const smaller = bytes.byteLength < before;
    const final = smaller ? bytes : doc.bytes;
    const pct = Math.round((1 - final.byteLength / before) * 100);
    return {
      files: [pdfOut(`${baseName(doc.name)}-compressed.pdf`, final)],
      title: smaller ? `Your PDF is ${pct}% smaller` : 'This PDF is already compact',
      note: smaller ? `${fmtSize(before)} → ${fmtSize(final.byteLength)}${total ? ` · ${done} of ${total} images made smaller` : ''}` : 'We could not make it smaller without losing quality, so this is your original file.',
    };
  },
};

// Re-encodes photos inside the PDF as smaller JPEGs. Vector text and drawings
// aren't touched. Images we can't decode safely are left as they are.
async function shrinkImages(lib, { maxSide, quality }, progress) {
  const { PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } = window.PDFLib;
  const N = (n) => PDFName.of(n);
  const jobs = [];
  for (const [ref, obj] of lib.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(N('Subtype'))?.toString() !== '/Image') continue;
    if (d.get(N('ImageMask'))?.toString() === 'true' || d.has(N('Decode')) || d.has(N('Mask'))) continue;
    const w = d.get(N('Width'))?.asNumber?.();
    const hgt = d.get(N('Height'))?.asNumber?.();
    if (!w || !hgt || w * hgt < 40000) continue; // icons and small images aren't worth it
    jobs.push({ ref, obj, w, hgt });
  }
  let done = 0;
  for (const [k, job] of jobs.entries()) {
    if (k % 3 === 0) { progress(k + 1, jobs.length); await tick(); }
    try {
      const img = await decodeImage(job.obj, job.w, job.hgt, { PDFName, decodePDFRawStream });
      if (!img) continue;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(img, 0, 0, c.width, c.height);
      img.close?.();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
      const jpg = new Uint8Array(await blob.arrayBuffer());
      if (jpg.byteLength >= job.obj.contents.byteLength * 0.9) continue;
      const nd = job.obj.dict.clone(lib.context);
      ['DecodeParms', 'DP', 'Filter', 'F', 'ColorSpace', 'BitsPerComponent', 'Length', 'Intent'].forEach((key) => nd.delete(N(key)));
      nd.set(N('Filter'), N('DCTDecode'));
      nd.set(N('ColorSpace'), N('DeviceRGB'));
      nd.set(N('BitsPerComponent'), PDFNumber.of(8));
      nd.set(N('Width'), PDFNumber.of(c.width));
      nd.set(N('Height'), PDFNumber.of(c.height));
      lib.context.assign(job.ref, PDFRawStream.of(nd, jpg));
      done++;
    } catch (err) { console.warn('kept image', err); }
  }
  return { done, total: jobs.length };
}

async function decodeImage(stream, w, hgt, { PDFName, decodePDFRawStream }) {
  const N = (n) => PDFName.of(n);
  const d = stream.dict;
  const filter = d.get(N('Filter'));
  const filters = filter ? (filter.asArray ? filter.asArray().map(String) : [String(filter)]) : [];
  const cs = d.lookup(N('ColorSpace'));
  const csName = cs?.asArray ? String(cs.asArray()[0]) : String(cs);
  let comps = csName === '/DeviceGray' || csName === '/CalGray' ? 1 : csName === '/DeviceRGB' || csName === '/CalRGB' ? 3 : 0;
  if (csName === '/ICCBased') {
    const iccN = cs.asArray()[1];
    const icc = d.context.lookup(iccN);
    comps = icc?.dict?.get(N('N'))?.asNumber?.() || 0;
  }
  // Photos already stored as JPEG: let the browser decode them (RGB/gray only).
  if (filters.length === 1 && filters[0] === '/DCTDecode') {
    if (comps !== 1 && comps !== 3) return null;
    return createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
  }
  // Raw pixels (Flate etc.): only plain 8-bit gray or RGB.
  if (filters.some((f) => !['/FlateDecode', '/LZWDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/RunLengthDecode'].includes(f))) return null;
  if ((d.get(N('BitsPerComponent'))?.asNumber?.() ?? 8) !== 8 || (comps !== 1 && comps !== 3)) return null;
  const data = decodePDFRawStream(stream).decode();
  if (data.length < w * hgt * comps) return null;
  const rgba = new Uint8ClampedArray(w * hgt * 4);
  for (let p = 0, q = 0; p < w * hgt; p++, q += comps) {
    const o = p * 4;
    rgba[o] = data[q]; rgba[o + 1] = data[comps === 3 ? q + 1 : q]; rgba[o + 2] = data[comps === 3 ? q + 2 : q]; rgba[o + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, w, hgt));
}

/* ---------- JPG -> PDF ---------- */

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

const jpgToPdf = {
  id: 'jpg-to-pdf', keywords: 'image photo png jpeg convert', title: 'JPG to PDF', icon: 'jpgToPdf', color: '#14b8a6', cat: 'convert', accept: 'image', multiple: true, action: 'Convert to PDF', busyText: 'Converting…',
  desc: 'Turn photos and scans into a PDF.',
  long: 'Turn JPG, PNG and WebP images into a PDF. Drag the images to set the page order.',
  setup(ctx) {
    const s = ctx.state = { size: 'a4', orient: 'auto', margin: 0, oneFile: true };
    for (const it of ctx.items) { it.uid = uid(); it.url = URL.createObjectURL(it.file); }
    const list = h('div', { class: 'cards' });
    const draw = () => {
      list.replaceChildren(...ctx.items.map((it) => h('div', { class: 'card', 'data-id': it.uid },
        h('div', { class: 'card__page' }, h('img', { class: 'thumb', src: it.url, alt: '', style: { imageOrientation: 'from-image' } })),
        h('div', { class: 'card__meta' }, h('strong', { title: it.name }, it.name), h('span', {}, fmtSize(it.size))),
        h('button', { class: 'iconbtn card__x', 'aria-label': `Remove ${it.name}`, onclick: () => { ctx.items.splice(ctx.items.indexOf(it), 1); draw(); } }, icon('x')),
        h('span', { class: 'grip', title: 'Drag to reorder' }, icon('grip')))),
      h('button', { class: 'card card--add', onclick: add }, icon('plus'), 'Add images'));
      ctx.action.disabled = !ctx.items.length;
    };
    const push = (more) => { more.forEach((it) => { it.uid = uid(); it.url = URL.createObjectURL(it.file); ctx.items.push(it); }); draw(); };
    const add = async () => push(await ctx.addMore());
    ctx.onDropMore = push;
    sortable(list, (ids) => ctx.items.sort((a, b) => ids.indexOf(a.uid) - ids.indexOf(b.uid)));
    ctx.main.append(list);
    ctx.side.append(
      field('Page size', segmented([['a4', 'A4'], ['letter', 'Letter'], ['fit', 'Same as image']], s.size, (v) => (s.size = v))),
      field('Orientation', segmented([['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], s.orient, (v) => (s.orient = v))),
      field('Margin', segmented([[0, 'None'], [18, 'Small'], [40, 'Big']], s.margin, (v) => (s.margin = v))),
      check('Put all images in one PDF', s.oneFile, (v) => (s.oneFile = v)));
    draw();
  },
  async run(ctx) {
    const s = ctx.state;
    const files = [];
    let doc = await PDFDocument.create();
    for (const [k, it] of ctx.items.entries()) {
      busy(`Adding image ${k + 1} of ${ctx.items.length}…`);
      await tick();
      const im = await imageForPdf(it.file, { maxSide: 3500 });
      const emb = im.png ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
      const m = s.margin;
      let pw, ph;
      // 96 dpi screen pixels -> PDF points
      const iw = im.width * 0.75, ih = im.height * 0.75;
      if (s.size === 'fit') { pw = iw + 2 * m; ph = ih + 2 * m; }
      else {
        [pw, ph] = SIZES[s.size];
        const land = s.orient === 'landscape' || (s.orient === 'auto' && im.width > im.height);
        if (land) [pw, ph] = [ph, pw];
      }
      const k2 = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih, s.size === 'fit' ? 1 : Infinity);
      const w = iw * k2, hh = ih * k2;
      const page = doc.addPage([pw, ph]);
      page.drawImage(emb, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
      if (!s.oneFile) {
        files.push(pdfOut(`${baseName(it.name)}.pdf`, await doc.save()));
        doc = await PDFDocument.create();
      }
    }
    if (s.oneFile) files.push(pdfOut(ctx.items.length === 1 ? `${baseName(ctx.items[0].name)}.pdf` : 'images.pdf', await doc.save()));
    return { files, zipName: 'images-pdf.zip', title: files.length > 1 ? `${files.length} PDFs are ready` : 'Your PDF is ready' };
  },
};

/* ---------- PDF -> JPG ---------- */

const pdfToJpg = {
  id: 'pdf-to-jpg', keywords: 'image png jpeg convert export', title: 'PDF to JPG', icon: 'pdfToJpg', color: '#06b6d4', cat: 'convert', action: 'Convert to images', wide: true, busyText: 'Converting…',
  desc: 'Save every page, or the pages you pick, as images.',
  long: 'Save PDF pages as JPG or PNG images. Click pages to leave them out.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { format: 'jpg', dpi: 150, skip: new Set() };
    const grid = pageGrid(doc, (cell, i) => {
      cell.classList.add('on');
      cell.append(h('span', { class: 'pg__tick' }, icon('check')));
      cell.addEventListener('click', () => { s.skip.has(i) ? s.skip.delete(i) : s.skip.add(i); cell.classList.toggle('on', !s.skip.has(i)); count(); });
    });
    grid.classList.add('pickable');
    const n = h('p', { class: 'muted' });
    const count = () => { const k = doc.pages - s.skip.size; n.textContent = `${k} image${k === 1 ? '' : 's'}`; ctx.action.disabled = !k; };
    ctx.main.append(grid);
    ctx.side.append(
      field('Format', segmented([['jpg', 'JPG'], ['png', 'PNG']], s.format, (v) => (s.format = v))),
      field('Quality', segmented([[96, 'Small'], [150, 'Normal'], [300, 'High']], s.dpi, (v) => (s.dpi = v))),
      n);
    count();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    const files = [];
    const want = [...Array(doc.pages).keys()].filter((i) => !s.skip.has(i));
    for (const [k, i] of want.entries()) {
      busy(`Page ${k + 1} of ${want.length}…`);
      const c = await renderPage(doc.js, i, 0, { lazy: false, scale: s.dpi / 72 });
      if (s.format === 'jpg') { // JPG has no transparency; keep paper white
        const w = document.createElement('canvas'); w.width = c.width; w.height = c.height;
        const x = w.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w.width, w.height); x.drawImage(c, 0, 0);
        c.getContext('2d').drawImage(w, 0, 0);
      }
      const blob = await new Promise((r) => c.toBlob(r, s.format === 'jpg' ? 'image/jpeg' : 'image/png', 0.9));
      c.width = c.height = 0;
      files.push({ name: `${baseName(doc.name)}-page-${i + 1}.${s.format}`, bytes: blob, type: blob.type });
    }
    return { files, zipName: `${baseName(doc.name)}-images.zip`, title: files.length > 1 ? `${files.length} images are ready` : 'Your image is ready' };
  },
};

/* ---------- WATERMARK ---------- */

const POS9 = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];

const watermark = {
  id: 'watermark', keywords: 'stamp logo brand', title: 'Add watermark', icon: 'watermark', color: '#e07a52', cat: 'edit', action: 'Add watermark', wide: true,
  desc: 'Stamp text or a logo across your pages.',
  long: 'Stamp text or an image on your pages. Choose where, how big and how see-through.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { kind: 'text', text: 'CONFIDENTIAL', size: 60, color: '#e11d48', opacity: 0.3, angle: 45, pos: 'mc', tile: false, img: null, imgScale: 40, pages: '' };
    const preview = previewPane(doc, (lib, idx) => stampWatermark(lib, idx, s));
    const up = () => preview.refresh();
    const posGrid = h('div', { class: 'pos9' }, POS9.map((p) => h('button', { type: 'button', class: p === s.pos ? 'on' : '', 'aria-label': p, onclick: (e) => { s.pos = p; posGrid.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); up(); } })));
    const imgName = h('span', { class: 'muted small' }, 'No image chosen');
    const textOpts = h('div', {},
      field('Text', h('input', { class: 'field', value: s.text, oninput: (e) => { s.text = e.target.value; up(); } })),
      field('Size', slider(12, 160, 2, s.size, (v) => `${v} pt`, (v) => { s.size = v; up(); })),
      field('Colour', h('input', { type: 'color', class: 'swatch', value: s.color, oninput: (e) => { s.color = e.target.value; up(); } })));
    const imgOpts = h('div', { hidden: true },
      h('button', { class: 'btn btn--ghost btn--block', onclick: async () => {
        const [f] = await pickFiles({ accept: 'image/*' });
        if (!f) return;
        s.img = await imageForPdf(f, { maxSide: 1600 });
        imgName.textContent = f.name; up();
      } }, icon('image'), 'Choose image'), imgName,
      field('Size', slider(5, 100, 1, s.imgScale, (v) => `${v}% of page width`, (v) => { s.imgScale = v; up(); })));
    ctx.main.append(preview);
    ctx.side.append(
      segmented([['text', 'Text'], ['image', 'Image']], s.kind, (v) => { s.kind = v; textOpts.hidden = v !== 'text'; imgOpts.hidden = v !== 'image'; up(); }),
      textOpts, imgOpts,
      field('See-through', slider(0.05, 1, 0.05, s.opacity, (v) => `${Math.round(v * 100)}%`, (v) => { s.opacity = v; up(); })),
      field('Angle', segmented([[0, '0°'], [45, '45°'], [90, '90°'], [-45, '−45°']], s.angle, (v) => { s.angle = v; up(); })),
      field('Position', posGrid),
      check('Repeat across the page', s.tile, (v) => { s.tile = v; posGrid.classList.toggle('off', v); up(); }),
      field('Pages (empty = all)', h('input', { class: 'field', placeholder: `e.g. 1-${doc.pages}`, oninput: (e) => (s.pages = e.target.value) })));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    if (s.kind === 'image' && !s.img) throw new Error('Choose an image for the watermark first.');
    const lib = await loadLib(doc);
    const idx = s.pages.trim() ? [...new Set(parseRanges(s.pages, doc.pages))] : lib.getPageIndices();
    await stampWatermark(lib, idx, s);
    return { files: [pdfOut(`${baseName(doc.name)}-watermarked.pdf`, await lib.save())] };
  },
};

async function stampWatermark(lib, indexes, s) {
  let mark; // { draw(page, cx, cy, frame) , w, h }
  if (s.kind === 'image') {
    if (!s.img) return;
    const emb = s.img.png ? await lib.embedPng(s.img.bytes) : await lib.embedJpg(s.img.bytes);
    mark = { emb, ratio: s.img.height / s.img.width };
  } else {
    if (!s.text.trim()) return;
    const font = await lib.embedFont(StandardFonts.HelveticaBold);
    if (fontCanDraw(font, s.text)) mark = { font };
    else {
      const png = await textAsPng(s.text, { bold: true, size: s.size, color: s.color });
      mark = { emb: await lib.embedPng(png.bytes), w: png.width, h: png.height };
    }
  }
  for (const i of indexes) {
    const page = lib.getPage(i);
    const f = pageFrame(page);
    let w, hgt;
    if (mark.font) { w = mark.font.widthOfTextAtSize(s.text, s.size); hgt = mark.font.heightAtSize(s.size, { descender: false }); }
    else if (mark.w) { w = mark.w; hgt = mark.h; }
    else { w = (f.W * s.imgScale) / 100; hgt = w * mark.ratio; }
    const draw = (cx, cy) => {
      const a = boxAnchor(f, cx, cy, w, hgt, s.angle);
      if (mark.font) page.drawText(s.text, { x: a.x, y: a.y, size: s.size, font: mark.font, color: hexToRgb(s.color), opacity: s.opacity, rotate: a.rotate });
      else page.drawImage(mark.emb, { x: a.x, y: a.y, width: w, height: hgt, opacity: s.opacity, rotate: a.rotate });
    };
    if (s.tile) {
      // Rotated footprint, then a staggered grid that covers the page.
      const t = (Math.abs(s.angle) * Math.PI) / 180;
      const bw = w * Math.cos(t) + hgt * Math.sin(t), bh = w * Math.sin(t) + hgt * Math.cos(t);
      const gx = bw + Math.max(40, bw * 0.35), gy = bh + Math.max(40, bh * 0.6);
      for (let row = 0, y = gy / 2; y < f.H + bh; y += gy, row++)
        for (let x = (row % 2 ? gx : gx / 2) - gx / 2; x < f.W + bw; x += gx) draw(x, y);
    } else {
      const m = 36;
      const t = (Math.abs(s.angle) * Math.PI) / 180;
      const bw = w * Math.cos(t) + hgt * Math.sin(t), bh = w * Math.sin(t) + hgt * Math.cos(t);
      const col = s.pos[1], row = s.pos[0];
      const cx = col === 'l' ? m + bw / 2 : col === 'r' ? f.W - m - bw / 2 : f.W / 2;
      const cy = row === 't' ? m + bh / 2 : row === 'b' ? f.H - m - bh / 2 : f.H / 2;
      draw(cx, cy);
    }
  }
}

/* ---------- PAGE NUMBERS ---------- */

const FORMATS = {
  n: (n) => `${n}`,
  page: (n) => `Page ${n}`,
  of: (n, t) => `Page ${n} of ${t}`,
  slash: (n, t) => `${n} / ${t}`,
};

const pageNumbers = {
  id: 'page-numbers', keywords: 'numbering footer', title: 'Page numbers', icon: 'numbers', color: '#a855f7', cat: 'edit', action: 'Add page numbers', wide: true,
  desc: 'Number your pages, with the style and position you choose.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { pos: 'bc', margin: 28, start: 1, format: 'n', size: 11, color: '#111111', pages: '', total: doc.pages };
    const preview = previewPane(doc, (lib, idx, real) => stampNumbers(lib, idx, s, real));
    const up = () => preview.refresh();
    const POS6 = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];
    const posGrid = h('div', { class: 'pos9 pos6' }, POS6.map((p) => h('button', { type: 'button', class: p === s.pos ? 'on' : '', 'aria-label': p, onclick: (e) => { s.pos = p; posGrid.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); up(); } })));
    ctx.main.append(preview);
    ctx.side.append(
      field('Position', posGrid),
      field('Margin', segmented([[16, 'Small'], [28, 'Medium'], [48, 'Big']], s.margin, (v) => { s.margin = v; up(); })),
      field('Style', h('select', { class: 'field', onchange: (e) => { s.format = e.target.value; up(); } },
        Object.keys(FORMATS).map((k) => h('option', { value: k, selected: k === s.format }, FORMATS[k](1, doc.pages))))),
      h('div', { class: 'row2' },
        field('First number', h('input', { class: 'field', type: 'number', min: 0, value: 1, oninput: (e) => { s.start = parseInt(e.target.value, 10) || 0; up(); } })),
        field('Text size', h('input', { class: 'field', type: 'number', min: 6, max: 48, value: s.size, oninput: (e) => { s.size = Math.min(48, Math.max(6, +e.target.value || 11)); up(); } }))),
      field('Colour', h('input', { type: 'color', class: 'swatch', value: s.color, oninput: (e) => { s.color = e.target.value; up(); } })),
      field('Pages to number (empty = all)', h('input', { class: 'field', placeholder: `e.g. 2-${doc.pages}`, oninput: (e) => { s.pages = e.target.value; up(); } })));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const lib = await loadLib(doc);
    await stampNumbers(lib, lib.getPageIndices(), ctx.state);
    return { files: [pdfOut(`${baseName(doc.name)}-numbered.pdf`, await lib.save())] };
  },
};

// indexes: pages of `lib` to stamp. realIndex: for previews, which page of the
// original file `lib`'s single page is.
async function stampNumbers(lib, indexes, s, realIndex) {
  const total = s.total;
  let chosen;
  try { chosen = s.pages.trim() ? [...new Set(parseRanges(s.pages, total))].sort((a, b) => a - b) : [...Array(total).keys()]; } catch { chosen = [...Array(total).keys()]; }
  const font = await lib.embedFont(StandardFonts.Helvetica);
  const last = s.start + chosen.length - 1;
  for (const i of indexes) {
    const real = realIndex ?? i;
    const k = chosen.indexOf(real);
    if (k < 0) continue;
    const text = FORMATS[s.format](s.start + k, last);
    const page = lib.getPage(i);
    const f = pageFrame(page);
    const w = font.widthOfTextAtSize(text, s.size);
    const hgt = font.heightAtSize(s.size, { descender: false });
    const col = s.pos[1];
    const cx = col === 'l' ? s.margin + w / 2 : col === 'r' ? f.W - s.margin - w / 2 : f.W / 2;
    const cy = s.pos[0] === 't' ? s.margin + hgt / 2 : f.H - s.margin - hgt / 2;
    const a = boxAnchor(f, cx, cy, w, hgt, 0);
    page.drawText(text, { x: a.x, y: a.y, size: s.size, font, color: hexToRgb(s.color), rotate: a.rotate });
  }
}

/* ---------- PROTECT / UNLOCK ---------- */

const protect = {
  id: 'protect', keywords: 'password encrypt lock secure', title: 'Protect PDF', icon: 'protect', color: '#10b981', cat: 'security', action: 'Protect PDF',
  desc: 'Lock a PDF with a password.',
  long: 'Add a password. Nobody can open the PDF without it. Uses AES-256 encryption.',
  setup(ctx) {
    const s = ctx.state = { pw: '', pw2: '', print: true, copy: true, modify: true };
    const show = check('Show password', false, (v) => { a.type = b.type = v ? 'text' : 'password'; });
    const a = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', oninput: (e) => { s.pw = e.target.value; val(); } });
    const b = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', oninput: (e) => { s.pw2 = e.target.value; val(); } });
    const msg = h('p', { class: 'muted small' });
    const val = () => {
      const ok = s.pw.length >= 1 && s.pw === s.pw2;
      ctx.action.disabled = !ok;
      msg.textContent = !s.pw ? '' : s.pw !== s.pw2 ? 'The two passwords are different.' : s.pw.length < 6 ? 'Works, but a longer password is safer.' : '';
      msg.classList.toggle('bad', !!s.pw2 && s.pw !== s.pw2);
    };
    ctx.main.append(fileHero(ctx.items[0]));
    ctx.side.append(
      field('Password', a), field('Type it again', b), show, msg,
      h('p', { class: 'f__label' }, 'Once opened, people can:'),
      check('Print it', s.print, (v) => (s.print = v)),
      check('Copy text from it', s.copy, (v) => (s.copy = v)),
      check('Change it', s.modify, (v) => (s.modify = v)),
      h('p', { class: 'muted small' }, 'Keep the password safe. If you forget it, the PDF cannot be opened.'));
    val();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    const lib = await loadLib(doc);
    const restricted = !s.print || !s.copy || !s.modify;
    const owner = restricted ? crypto.getRandomValues(new Uint32Array(4)).join('-') : s.pw;
    lib.encrypt({
      userPassword: s.pw, ownerPassword: owner,
      permissions: { printing: s.print ? 'highResolution' : false, copying: s.copy, modifying: s.modify, annotating: s.modify, fillingForms: true, contentAccessibility: true, documentAssembly: s.modify },
    });
    return { files: [pdfOut(`${baseName(doc.name)}-protected.pdf`, await lib.save())], title: 'Your PDF is locked', note: 'It will ask for the password every time it is opened.' };
  },
};

const unlock = {
  id: 'unlock', keywords: 'password decrypt remove', title: 'Unlock PDF', icon: 'unlock', color: '#22c55e', cat: 'security', action: 'Unlock PDF',
  desc: 'Remove the password from a PDF you can open.',
  long: 'Remove the password and restrictions from a PDF. You need to know its password.',
  async setup(ctx) {
    const doc = ctx.items[0];
    let locked = true;
    try { await PDFDocument.load(doc.bytes, { updateMetadata: false }); locked = false; } catch { /* encrypted */ }
    ctx.main.append(fileHero(doc));
    ctx.side.append(h('p', {}, locked
      ? (doc.password != null ? 'Password accepted. Press the button to save a copy without it.' : 'This PDF has restrictions (no password to open). Press the button to remove them.')
      : 'This PDF has no password or restrictions. There is nothing to remove.'));
    ctx.action.disabled = !locked;
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const lib = await loadLib(doc);
    return { files: [pdfOut(`${baseName(doc.name)}-unlocked.pdf`, await lib.save())], title: 'Your PDF is unlocked', note: 'It opens without a password now.' };
  },
};

export const TOOLS = [
  merge, split, organize, rotate, compress, jpgToPdf, pdfToJpg,
  editorTool('edit'), editorTool('sign'), watermark, pageNumbers, protect, unlock,
];
