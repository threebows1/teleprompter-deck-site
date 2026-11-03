// More page tools: remove and extract pages, scan paper to PDF, repair a
// damaged file and crop pages.
import {
  h, icon, registerIcons, busy, toast, tick, modal, PDFDocument, loadLib, renderPage, baseName, fmtSize,
  parseRanges, pageFrame, isPdf, sortable, uid,
} from '../core.js';
import { field, segmented, choiceCards, fileRow, pageGrid, pdfOut } from '../ui.js';

registerIcons({
  removePages: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>',
  extractPages: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/><path d="M13 3v5h5"/><path d="M18 8v4"/><path d="M14 17h7"/><path d="m18 14 3 3-3 3"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>',
  repair: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  scanText: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// [0,1,2,4] -> "1-3, 5"
function rangeText(list) {
  const a = [...list].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < a.length;) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(i === j ? `${a[i] + 1}` : `${a[i] + 1}-${a[j] + 1}`);
    i = j + 1;
  }
  return out.join(', ');
}

// Copies pages (in this order) into a fresh PDF. Unlike removing pages in
// place, this leaves the dropped pages' images and fonts behind.
async function copyOut(src, indexes) {
  const out = await PDFDocument.create();
  (await out.copyPages(src, indexes)).forEach((p) => out.addPage(p));
  return out.save();
}

/* ---------- picking pages: clicks and a typed range, kept in step ---------- */

function pagePicker(doc, { mark, gridClass, onChange }) {
  const marked = new Set();
  const err = h('p', { class: 'muted small bad', hidden: true });
  const paint = () => {
    grid.querySelectorAll('.pg').forEach((c) => c.classList.toggle('on', marked.has(+c.dataset.i)));
    onChange();
  };
  const set = (indexes) => {
    marked.clear();
    indexes.forEach((i) => marked.add(i));
    input.value = rangeText(marked);
    err.hidden = true;
    paint();
  };
  const grid = pageGrid(doc, (cell, i) => {
    cell.append(h('span', { class: 'pg__tick' }, icon(mark)));
    cell.addEventListener('click', () => { marked.has(i) ? marked.delete(i) : marked.add(i); set([...marked]); });
  });
  grid.classList.add(gridClass);
  const input = h('input', {
    class: 'field', inputmode: 'numeric', placeholder: `e.g. 2, 4-${doc.pages}`,
    oninput: () => {
      err.hidden = true;
      marked.clear();
      if (input.value.trim()) {
        try { parseRanges(input.value, doc.pages).forEach((i) => marked.add(i)); } catch (e) { err.textContent = e.message; err.hidden = false; }
      }
      paint();
    },
  });
  return { grid, input, err, marked, set, paint };
}

/* ---------- REMOVE PAGES ---------- */

const removePages = {
  id: 'remove-pages', keywords: 'delete pages drop', title: 'Remove pages', icon: 'removePages', color: '#f43f5e', cat: 'organize', action: 'Remove pages', wide: true,
  desc: 'Delete the pages you don’t need from a PDF.',
  long: 'Click the pages you want to delete, or type their numbers. Bookmarks, links and form fields are not kept in the new file.',
  setup(ctx) {
    const doc = ctx.items[0];
    const hint = h('p', { class: 'muted' });
    const pick = ctx.state = pagePicker(doc, {
      mark: 'x', gridClass: 'rm-grid',
      onChange: () => {
        const n = pick.marked.size;
        const all = n === doc.pages;
        hint.textContent = all ? 'You can’t remove every page. Leave at least one.'
          : n ? `Removing ${plural(n, 'page')}, ${doc.pages - n} left.` : 'Click the pages you want to remove.';
        hint.classList.toggle('bad', all);
        ctx.action.disabled = !n || all;
      },
    });
    ctx.main.append(pick.grid);
    ctx.side.append(fileRow(doc), field('Pages to remove', pick.input), pick.err, hint);
    pick.paint();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const src = await loadLib(doc);
    const keep = src.getPageIndices().filter((i) => !ctx.state.marked.has(i));
    const bytes = await copyOut(src, keep);
    return { files: [pdfOut(`${baseName(doc.name)}-pages-removed.pdf`, bytes)], title: 'Pages removed', note: `${plural(doc.pages - keep.length, 'page')} removed, ${keep.length} left.` };
  },
};

/* ---------- EXTRACT PAGES ---------- */

const extractPages = {
  id: 'extract-pages', keywords: 'select pages take out save copy', title: 'Extract pages', icon: 'extractPages', color: '#0891b2', cat: 'organize', action: 'Extract pages', wide: true,
  desc: 'Save chosen pages as a new PDF.',
  long: 'Pick the pages you want, by clicking or typing. Save them as one PDF, or each page as its own PDF.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = { separate: false };
    const hint = h('p', { class: 'muted' });
    const pick = pagePicker(doc, {
      mark: 'check', gridClass: 'pickable',
      onChange: () => {
        const n = pick.marked.size;
        hint.textContent = !n ? 'Click the pages you want to extract.' : s.separate ? `${plural(n, 'PDF')}, saved together in a ZIP.` : `One PDF with ${plural(n, 'page')}.`;
        ctx.action.disabled = !n;
      },
    });
    ctx.state = { s, pick };
    const all = [...Array(doc.pages).keys()];
    const quick = (label, keep) => h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => pick.set(all.filter(keep)) }, label);
    ctx.main.append(pick.grid);
    ctx.side.append(
      fileRow(doc),
      field('Pages to extract', pick.input), pick.err,
      h('div', { class: 'org-quick' }, quick('All', () => true), quick('Odd', (i) => i % 2 === 0), quick('Even', (i) => i % 2 === 1), quick('None', () => false)),
      field('Save as', segmented([[false, 'One PDF'], [true, 'A PDF per page']], s.separate, (v) => { s.separate = v; pick.paint(); })),
      hint);
    pick.paint();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const { s, pick } = ctx.state;
    const src = await loadLib(doc);
    const base = baseName(doc.name);
    const pages = [...pick.marked].sort((a, b) => a - b);
    if (!s.separate) return { files: [pdfOut(`${base}-extracted.pdf`, await copyOut(src, pages))], title: 'Your pages are extracted', note: `${plural(pages.length, 'page')} in one PDF.` };
    const files = [];
    for (const [k, i] of pages.entries()) {
      busy(`Making file ${k + 1} of ${pages.length}…`);
      await tick();
      files.push(pdfOut(`${base}-page-${i + 1}.pdf`, await copyOut(src, [i])));
    }
    return { files, zipName: `${base}-pages.zip`, title: files.length > 1 ? `${files.length} PDFs are ready` : 'Your page is extracted' };
  },
};

/* ---------- crop box (Crop PDF and Scan to PDF) ---------- */

// A box over `stage` (position: relative, wrapping the picture exactly).
// rect is in fractions of the stage: { x, y, w, h }. Drag inside to move it,
// or a corner or edge to resize. Pointer events, so touch works too.
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const isFull = (r) => r.x < 0.002 && r.y < 0.002 && r.w > 0.996 && r.h > 0.996;

function cropper(stage, rect, onChange) {
  const MIN = 0.05;
  const box = h('div', { class: 'crop__box', 'aria-label': 'Crop area' },
    ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'].map((d) => h('span', { class: `crop__h crop__h--${d}`, 'data-d': d })));
  stage.append(box);
  const place = () => Object.assign(box.style, { left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.w * 100 + '%', height: rect.h * 100 + '%' });
  box.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    const d = e.target.dataset.d || 'move';
    const r0 = { ...rect };
    const S = stage.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    box.setPointerCapture(e.pointerId);
    box.classList.add('dragging');
    const move = (ev) => {
      const dx = (ev.clientX - sx) / S.width, dy = (ev.clientY - sy) / S.height;
      let { x, y, w, h: hh } = r0;
      if (d === 'move') { x = clamp(x + dx, 0, 1 - w); y = clamp(y + dy, 0, 1 - hh); }
      if (d.includes('w')) { const nx = clamp(x + dx, 0, x + w - MIN); w += x - nx; x = nx; }
      if (d.includes('e')) w = clamp(w + dx, MIN, 1 - x);
      if (d.includes('n')) { const ny = clamp(y + dy, 0, y + hh - MIN); hh += y - ny; y = ny; }
      if (d.includes('s')) hh = clamp(hh + dy, MIN, 1 - y);
      rect = { x, y, w, h: hh };
      place();
      onChange(rect);
    };
    const up = () => {
      box.classList.remove('dragging');
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  });
  place();
  return { set(r) { rect = { ...r }; place(); } };
}

/* ---------- CROP PDF ---------- */

// Where the ink is on a page, as fractions of the page as shown.
async function contentBounds(js, i) {
  const c = await renderPage(js, i, 0, { lazy: false, scale: 0.75 });
  const { width: w, height: hh } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) {
    for (let x = 0, o = y * w * 4; x < w; x++, o += 4) {
      if (d[o + 3] < 16 || (d[o] > 240 && d[o + 1] > 240 && d[o + 2] > 240)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  c.width = c.height = 0;
  return x1 < 0 ? null : { x0: x0 / w, y0: y0 / hh, x1: (x1 + 1) / w, y1: (y1 + 1) / hh };
}

const crop = {
  id: 'crop', keywords: 'trim margins cut edges', title: 'Crop PDF', icon: 'crop', color: '#eab308', cat: 'edit', action: 'Crop PDF', wide: true, busyText: 'Cropping…',
  desc: 'Trim the margins or cut pages down to one area.',
  long: 'Drag the box over the part you want to keep, on every page or just one. Cropping hides the rest but does not delete it, so don’t use it to hide private things.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { mode: 'all', all: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, per: new Map() };
    const sizes = [];
    let index = 0;
    const rectFor = (i) => (s.mode === 'all' ? s.all : s.per.get(i) || FULL);
    const keep = (r) => { if (s.mode === 'all') s.all = r; else s.per.set(index, r); };
    const stage = h('div', { class: 'crop__stage' }, h('canvas'));
    const box = cropper(stage, rectFor(0), (r) => { keep(r); info(); });
    const label = h('span', {});
    const prev = h('button', { class: 'iconbtn', 'aria-label': 'Previous page', onclick: () => show(index - 1) }, icon('back'));
    const next = h('button', { class: 'iconbtn flip', 'aria-label': 'Next page', onclick: () => show(index + 1) }, icon('back'));
    const holder = h('div', { class: 'preview__page crop__holder' }, stage);
    const size = h('p', { class: 'muted small' });
    const modeNote = h('p', { class: 'muted small' });
    const info = () => {
      const r = rectFor(index);
      const p = sizes[index];
      size.textContent = p ? `This page after cropping: ${Math.round(p.w * r.w)} × ${Math.round(p.h * r.h)} pt (now ${Math.round(p.w)} × ${Math.round(p.h)}).` : '';
      const changed = rangeText([...s.per].filter(([, r]) => !isFull(r)).map(([k]) => k));
      modeNote.textContent = s.mode === 'all'
        ? 'The same area is kept on every page, measured as a share of each page.'
        : `Each page keeps its own box; pages you don’t change stay as they are.${changed ? ` Changed: page ${changed}.` : ''}`;
    };
    let drawing = 0;
    const show = async (i) => {
      index = clamp(i, 0, doc.pages - 1);
      label.textContent = `Page ${index + 1} of ${doc.pages}`;
      prev.disabled = index === 0;
      next.disabled = index === doc.pages - 1;
      box.set(rectFor(index));
      info();
      const p = sizes[index];
      const room = holder.clientWidth - 2 * parseFloat(getComputedStyle(holder).paddingLeft);
      const width = Math.min(Math.max(200, room), 620, (Math.max(360, window.innerHeight * 0.68) * p.w) / p.h);
      const mine = ++drawing;
      const c = await renderPage(doc.js, index, width, { lazy: false });
      if (mine === drawing) stage.querySelector('canvas').replaceWith(c);
    };
    const auto = async () => {
      busy('Finding the margins…');
      await tick();
      try {
        // All pages: the smallest box that holds the content of every page (the first 30).
        const pages = s.mode === 'all' ? [...Array(Math.min(doc.pages, 30)).keys()] : [index];
        let b = null;
        for (const i of pages) {
          const r = await contentBounds(doc.js, i);
          if (r) b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : r;
        }
        if (!b) { toast('This page looks blank, so there are no margins to find.'); return; }
        const pad = 0.015;
        const x = Math.max(0, b.x0 - pad), y = Math.max(0, b.y0 - pad);
        const r = { x, y, w: Math.min(1, b.x1 + pad) - x, h: Math.min(1, b.y1 + pad) - y };
        keep(r);
        box.set(r);
        info();
      } finally { busy(false); }
    };
    ctx.main.append(h('div', { class: 'preview' }, holder, h('div', { class: 'preview__nav' }, prev, label, next)));
    ctx.side.append(
      fileRow(doc),
      field('Apply to', segmented([['all', 'All pages'], ['page', 'This page only']], s.mode, (v) => {
        // Switching to one page keeps the box that is on screen for this page.
        if (v === 'page' && !s.per.has(index)) s.per.set(index, { ...s.all });
        s.mode = v;
        box.set(rectFor(index));
        info();
      })),
      modeNote,
      h('button', { class: 'btn btn--ghost btn--block', onclick: auto }, icon('scanText'), 'Auto-detect margins'),
      h('button', { class: 'btn btn--ghost btn--block', onclick: () => { keep({ ...FULL }); box.set(FULL); info(); } }, 'Reset to the whole page'),
      size);
    (async () => {
      for (let i = 1; i <= doc.pages; i++) {
        const v = (await doc.js.getPage(i)).getViewport({ scale: 1 });
        sizes.push({ w: v.width, h: v.height });
      }
      show(0);
    })();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    const { PDFName } = window.PDFLib;
    const lib = await loadLib(doc);
    const pages = lib.getPages();
    let n = 0;
    pages.forEach((page, i) => {
      const r = s.mode === 'all' ? s.all : s.per.get(i);
      if (!r || isFull(r)) return;
      // The box is in view space (after /Rotate); map two corners to PDF space.
      const f = pageFrame(page);
      const a = f.map(r.x * f.W, r.y * f.H);
      const b = f.map((r.x + r.w) * f.W, (r.y + r.h) * f.H);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), hh = Math.abs(a.y - b.y);
      // MediaBox too, so every viewer and printer agrees on the page size.
      page.setMediaBox(x, y, w, hh);
      page.setCropBox(x, y, w, hh);
      ['TrimBox', 'BleedBox', 'ArtBox'].forEach((k) => page.node.delete(PDFName.of(k)));
      n++;
    });
    if (!n) throw new Error('Drag the edges of the box first. Right now nothing would be cut off.');
    return { files: [pdfOut(`${baseName(doc.name)}-cropped.pdf`, await lib.save())], title: 'Your PDF is cropped', note: `${n} of ${plural(pages.length, 'page')} cropped.` };
  },
};

/* ---------- REPAIR ---------- */

// pdf-lib reads a file object by object rather than trusting its index, so
// it gets past broken or missing cross-reference tables. Pages are copied
// into a fresh document; if the page tree itself is broken, the loose page
// objects are collected instead.
async function rebuild(bytes) {
  const { PDFName, PDFDict, PDFPage, PDFPageLeaf, PDFObjectCopier } = window.PDFLib;
  const N = (n) => PDFName.of(n);
  const src = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
  const out = await PDFDocument.create();
  let count = 0;
  try { count = src.getPageCount(); } catch { /* broken page tree */ }
  if (count) {
    (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
    return { out, how: 'tree' };
  }
  const copier = PDFObjectCopier.for(src.context, out.context);
  for (const [, obj] of src.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFPageLeaf)) continue;
    // Take what a page usually inherits from its (broken) parent, then cut the link.
    const parent = obj.lookup(N('Parent'));
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const v = parent instanceof PDFDict && parent.get(N(k));
      if (v && !obj.get(N(k))) obj.set(N(k), v);
    }
    obj.delete(N('Parent'));
    const node = copier.copy(obj);
    if (!node.get(N('MediaBox'))) node.set(N('MediaBox'), out.context.obj([0, 0, 612, 792]));
    out.addPage(PDFPage.of(node, out.context.register(node), out));
  }
  if (!out.getPageCount()) throw new Error('No pages found');
  return { out, how: 'loose' };
}

// Last resort: let pdf.js (which reads some files pdf-lib can't) draw each
// page, and build a new PDF from the pictures.
async function rasterize(js) {
  const out = await PDFDocument.create();
  for (let i = 0; i < js.numPages; i++) {
    busy(`Recovering page ${i + 1} of ${js.numPages}…`);
    await tick();
    try {
      const vp = (await js.getPage(i + 1)).getViewport({ scale: 1 });
      const c = await renderPage(js, i, 0, { lazy: false, scale: 2 });
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      c.width = c.height = 0;
      const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      out.addPage([vp.width, vp.height]).drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
    } catch (err) { console.warn('page lost', i + 1, err); }
  }
  return out;
}

const openJs = (bytes) => window.pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, stopAtErrors: false }).promise;

const repair = {
  id: 'repair', keywords: 'fix broken corrupt damaged recover', title: 'Repair PDF', icon: 'repair', color: '#475569', cat: 'optimize', action: 'Repair PDF', busyText: 'Repairing…',
  // Taken as a plain file: a damaged PDF often won't open the normal way.
  accept: { accept: 'application/pdf,.pdf', test: isPdf, label: 'PDF file' },
  desc: 'Recover what can still be read from a damaged PDF.',
  long: 'Rebuilds a damaged PDF from the parts that can still be read. Bookmarks, links and form fields are not kept. If the file is badly broken, pages come back as pictures and their text can’t be selected.',
  async setup(ctx) {
    const it = ctx.items[0];
    const page = h('div', { class: 'hero-file__page' }, h('span', { class: 'org-fileicon' }, icon('file')));
    const status = h('p', {}, 'Checking the file…');
    ctx.main.append(h('div', { class: 'hero-file' }, page, h('strong', { title: it.name }, it.name), h('span', {}, fmtSize(it.size))));
    ctx.side.append(status, h('p', { class: 'muted small' }, 'The repaired copy is a new file. Your original is not changed.'));
    it.bytes = new Uint8Array(await it.file.arrayBuffer());
    try {
      const js = await openJs(it.bytes);
      status.textContent = `This file opens and has ${plural(js.numPages, 'page')}. Repairing writes a clean copy, which fixes many errors other apps report.`;
      const c = await renderPage(js, 0, 200, { lazy: false, canvas: h('canvas', { class: 'thumb' }) }).catch(() => null);
      if (c) page.replaceChildren(c);
      js.destroy();
    } catch (err) {
      if (err?.name === 'PasswordException') {
        status.textContent = 'This PDF has a password. Remove it with Unlock PDF first, then repair the unlocked copy.';
        ctx.action.disabled = true;
      } else status.textContent = 'This file does not open as it is. Repair will try to recover its pages.';
    }
  },
  async run(ctx) {
    const it = ctx.items[0];
    let rebuilt = null;
    try {
      const { out, how } = await rebuild(it.bytes);
      const bytes = await out.save();
      // Only count it as fixed if a reader can open the result.
      const check = await openJs(bytes);
      rebuilt = { bytes, pages: check.numPages, how };
      check.destroy();
    } catch (err) { console.warn('rebuild failed', err); }
    let js = null;
    try { js = await openJs(it.bytes); } catch { /* unreadable to pdf.js too */ }
    const name = `${baseName(it.name)}-repaired.pdf`;
    // Prefer the rebuilt file (text stays text) unless pictures save more pages.
    if (rebuilt && (!js || rebuilt.pages >= js.numPages)) {
      js?.destroy();
      return {
        files: [pdfOut(name, rebuilt.bytes)], title: 'Your PDF is repaired',
        note: `Rebuilt ${rebuilt.how === 'loose' ? 'from its loose pages' : 'from its contents'}: ${plural(rebuilt.pages, 'page')} recovered. Text is still selectable.`,
      };
    }
    if (!js) throw new Error('This file is too damaged to recover. No pages could be read.');
    const out = await rasterize(js);
    js.destroy();
    if (!out.getPageCount()) throw new Error('This file is too damaged to recover. No pages could be read.');
    return {
      files: [pdfOut(name, await out.save())], title: 'Your PDF is repaired',
      note: `Recovered ${out.getPageCount()} of ${plural(js.numPages, 'page')} as pictures. Their text can’t be selected.`,
    };
  },
};

/* ---------- SCAN TO PDF ---------- */

// Full-screen camera. Resolves with the photos taken ([] if cancelled).
async function camera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('This browser can’t use the camera here. Pick photos instead.', 'bad');
    return [];
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
  } catch (err) {
    toast(err?.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in your browser, or pick photos instead.' : 'No camera found. Pick photos instead.', 'bad');
    return [];
  }
  return new Promise((resolve) => {
    const shots = [];
    const video = h('video', { class: 'cam__video', autoplay: true, playsinline: true });
    video.muted = true;
    video.srcObject = stream;
    const strip = h('div', { class: 'cam__strip' });
    const label = h('span', { class: 'cam__count' });
    const done = h('button', { class: 'btn btn--solid', disabled: true, onclick: () => close(true) }, icon('check'), 'Done');
    const flash = h('div', { class: 'cam__flash' });
    const count = () => { done.disabled = !shots.length; label.textContent = shots.length ? plural(shots.length, 'photo') : 'Hold the page flat and fill the frame'; };
    const take = async () => {
      if (!video.videoWidth) return;
      const c = h('canvas', { width: video.videoWidth, height: video.videoHeight });
      c.getContext('2d').drawImage(video, 0, 0);
      flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      const n = shots.length + 1;
      const file = new File([blob], `scan-${n}.jpg`, { type: 'image/jpeg' });
      const shot = { file, name: file.name, size: file.size, url: URL.createObjectURL(blob) };
      shots.push(shot);
      strip.append(h('div', { class: 'cam__thumb' }, h('img', { src: shot.url, alt: `Photo ${n}` }),
        h('button', { class: 'iconbtn', 'aria-label': `Remove photo ${n}`, onclick: (e) => { shots.splice(shots.indexOf(shot), 1); URL.revokeObjectURL(shot.url); e.currentTarget.parentNode.remove(); count(); } }, icon('x'))));
      strip.scrollLeft = strip.scrollWidth;
      count();
    };
    const close = (keep) => {
      stream.getTracks().forEach((t) => t.stop());
      shots.forEach((s) => URL.revokeObjectURL(s.url));
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(keep ? shots.map(({ file, name, size }) => ({ file, name, size })) : []);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const wrap = h('div', { class: 'cam', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Camera' },
      h('div', { class: 'cam__view' }, video, flash),
      h('div', { class: 'cam__bar' },
        strip, label,
        h('div', { class: 'cam__controls' },
          h('button', { class: 'btn btn--ghost', onclick: () => close(false) }, 'Cancel'),
          h('button', { class: 'cam__snap', 'aria-label': 'Take photo', onclick: take }),
          done)));
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    count();
  });
}

// Draws `src` turned `rot` degrees clockwise, cut to `cut` (fractions of the
// turned picture), at most `maxSide` pixels, with the chosen look applied.
function processImage(src, { rot, cut, look }, maxSide) {
  const side = rot % 180 !== 0;
  const rw = side ? src.height : src.width, rh = side ? src.width : src.height;
  const r = cut || FULL;
  const cw = r.w * rw, ch = r.h * rh;
  const k = Math.min(1, maxSide / Math.max(cw, ch));
  const c = h('canvas', { width: Math.max(1, Math.round(cw * k)), height: Math.max(1, Math.round(ch * k)) });
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.scale(k, k);
  x.translate(-r.x * rw + rw / 2, -r.y * rh + rh / 2);
  x.rotate((rot * Math.PI) / 180);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  if (look !== 'original') applyLook(c, look);
  return c;
}

function applyLook(c, look) {
  const x = c.getContext('2d');
  const img = x.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // Document: divide by a blurred copy (the paper's own brightness), so
  // shadows and uneven light turn white while ink stays dark.
  const bg = look === 'doc' ? blurred(c).getContext('2d').getImageData(0, 0, c.width, c.height).data : null;
  for (let o = 0; o < d.length; o += 4) {
    let g = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    if (bg) {
      const paper = Math.max(1, 0.299 * bg[o] + 0.587 * bg[o + 1] + 0.114 * bg[o + 2]);
      g = clamp(((g / paper - 0.6) / 0.28) * 255, 0, 255);
    }
    d[o] = d[o + 1] = d[o + 2] = g;
  }
  x.putImageData(img, 0, 0);
}

// Halves the picture until it is tiny, then stretches it back: a cheap,
// wide blur that works in every browser.
function blurred(c) {
  let cur = c;
  while (Math.max(cur.width, cur.height) > 48) {
    const n = h('canvas', { width: Math.max(1, cur.width >> 1), height: Math.max(1, cur.height >> 1) });
    n.getContext('2d').drawImage(cur, 0, 0, n.width, n.height);
    cur = n;
  }
  const out = h('canvas', { width: c.width, height: c.height });
  const x = out.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, c.width, c.height);
  return out;
}

// Turns a crop box along with its picture, 90° either way.
const turnRect = (r, by) => (by > 0 ? { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w } : { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w });

// EXIF rotation applied, at most maxSide pixels.
async function decode(file, maxSide) {
  const full = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, maxSide / Math.max(full.width, full.height));
  if (k === 1) return full;
  const small = await createImageBitmap(full, { resizeWidth: Math.round(full.width * k), resizeHeight: Math.round(full.height * k), resizeQuality: 'high' });
  full.close();
  return small;
}

const LOOKS = [['original', 'Original', 'Colors as photographed'], ['gray', 'Grayscale', 'Black, white and grays'], ['doc', 'Document', 'Crisp black text on white']];
const A4 = [595.28, 841.89];

const scan = {
  id: 'scan', keywords: 'camera photo scanner paper document', title: 'Scan to PDF', icon: 'scan', color: '#9333ea', cat: 'organize', accept: 'image', multiple: true, wide: true,
  action: 'Make PDF', busyText: 'Making your PDF…',
  desc: 'Photograph paper pages and turn them into a clean PDF.',
  long: 'Take photos with your camera or pick them from your device. Turn, crop and clean them up, then save one A4 PDF. Pages are pictures, so their text can’t be selected.',
  dropExtra: (start) => [h('button', { class: 'btn btn--soft btn--big', onclick: async () => { const shots = await camera(); if (shots.length) start(shots); } }, icon('camera'), 'Use camera')],
  setup(ctx) {
    const s = ctx.state = { look: 'original' };
    const list = h('div', { class: 'cards' });
    const count = h('p', { class: 'muted' });
    const redraw = async (it) => {
      it.small ||= await decode(it.file, 900);
      const c = processImage(it.small, it, 360);
      c.classList.add('thumb');
      it.thumb.replaceChildren(c);
    };
    const prep = (it) => {
      Object.assign(it, { uid: uid(), rot: 0, cut: null, look: s.look, thumb: h('div', { class: 'card__page' }) });
      redraw(it).catch(() => { it.bad = true; it.thumb.replaceChildren(h('span', { class: 'muted small' }, 'Can’t read this image')); });
      return it;
    };
    const turn = (it, by) => { it.rot = (it.rot + by + 360) % 360; if (it.cut) it.cut = turnRect(it.cut, by); redraw(it); };
    const edit = async (it) => {
      it.small ||= await decode(it.file, 900);
      let cut = it.cut || FULL;
      let look = it.look;
      const stage = h('div', { class: 'crop__stage' }, h('canvas'));
      const paint = () => stage.querySelector('canvas').replaceWith(processImage(it.small, { rot: it.rot, cut: null, look }, 900));
      paint();
      const box = cropper(stage, cut, (r) => (cut = r));
      const ok = await modal({
        title: 'Crop and clean up', wide: true, okText: 'Apply',
        body: () => [
          h('div', { class: 'crop__holder org-edit' }, stage),
          h('p', { class: 'muted small' }, 'Drag the corners to the edges of the page.'),
          field('Look', segmented(LOOKS.map(([v, t]) => [v, t]), look, (v) => { look = v; paint(); })),
          h('button', { class: 'linkbtn', type: 'button', onclick: () => { cut = { ...FULL }; box.set(FULL); } }, 'Reset crop'),
        ],
      });
      if (!ok) return;
      it.cut = isFull(cut) ? null : cut;
      it.look = look;
      redraw(it);
    };
    const draw = () => {
      list.replaceChildren(...ctx.items.map((it, k) => h('div', { class: 'card', 'data-id': it.uid },
        it.thumb,
        h('div', { class: 'card__meta' }, h('strong', {}, `Page ${k + 1}`), h('span', { title: it.name }, it.name)),
        h('div', { class: 'pg__tools org-tools' },
          h('button', { class: 'iconbtn', title: 'Turn left', 'aria-label': 'Turn left', onclick: () => turn(it, -90) }, icon('rotateLeft')),
          h('button', { class: 'iconbtn', title: 'Turn right', 'aria-label': 'Turn right', onclick: () => turn(it, 90) }, icon('rotate')),
          h('button', { class: 'iconbtn', title: 'Crop and look', 'aria-label': 'Crop and look', disabled: it.bad, onclick: () => edit(it) }, icon('crop'))),
        h('button', { class: 'iconbtn card__x', 'aria-label': `Remove ${it.name}`, onclick: () => { ctx.items.splice(ctx.items.indexOf(it), 1); draw(); } }, icon('x')),
        h('span', { class: 'grip', title: 'Drag to reorder' }, icon('grip')))),
      h('button', { class: 'card card--add', onclick: add }, icon('plus'), 'Add images'));
      ctx.action.disabled = !ctx.items.length;
      count.textContent = ctx.items.length ? `${plural(ctx.items.length, 'page')}, A4 with a small margin.` : 'Add at least one image.';
    };
    const push = (more) => { more.forEach((it) => ctx.items.push(prep(it))); draw(); };
    const add = async () => push(await ctx.addMore());
    ctx.onDropMore = push;
    ctx.items.forEach(prep);
    sortable(list, (ids) => { ctx.items.sort((a, b) => ids.indexOf(a.uid) - ids.indexOf(b.uid)); draw(); });
    ctx.main.append(list);
    ctx.side.append(
      h('p', {}, 'Drag pages to change their order. Use the buttons on a page to turn or crop it.'),
      field('Look of every page', choiceCards(LOOKS, s.look, (v) => { s.look = v; ctx.items.forEach((it) => { it.look = v; redraw(it); }); })),
      h('button', { class: 'btn btn--ghost btn--block', onclick: async () => push(await camera()) }, icon('camera'), 'Take more photos'),
      count);
    draw();
  },
  async run(ctx) {
    const items = ctx.items.filter((it) => !it.bad);
    if (!items.length) throw new Error('None of these images can be read. Try JPG or PNG files.');
    const doc = await PDFDocument.create();
    const m = 18;
    for (const [k, it] of items.entries()) {
      busy(`Adding page ${k + 1} of ${items.length}…`);
      await tick();
      const bmp = await decode(it.file, 3000);
      const c = processImage(bmp, it, 3000);
      bmp.close?.();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      // A4, turned to suit the picture, which fits inside a small margin.
      const [pw, ph] = c.width > c.height ? [A4[1], A4[0]] : A4;
      const f = Math.min((pw - 2 * m) / c.width, (ph - 2 * m) / c.height);
      const w = c.width * f, hh = c.height * f;
      c.width = c.height = 0;
      doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
    }
    return { files: [pdfOut('scan.pdf', await doc.save())], title: 'Your scan is ready', note: `${plural(items.length, 'page')}, A4.` };
  },
};

export const ORGANIZE_MORE = [removePages, extractPages, scan, repair, crop];
