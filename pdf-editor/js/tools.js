// Every tool: what it shows while you set it up, and what it does when you press its button.
import {
  h, icon, busy, toast, tick, PDFDocument, StandardFonts, rgb, degrees, loadLib, renderPage, fmtSize, baseName,
  parseRanges, pageFrame, boxAnchor, fontCanDraw, textAsPng, hexToRgb, imageForPdf, sortable, uid, pickFiles,
} from './core.js';
import { editorTool } from './editor.js';
import { parseOps, readPage } from './content.js';
import {
  field, segmented, choiceCards, check, slider, debounce, fileHero, fileRow, GROUP_COLORS, fileCard, pageGrid, pdfOut, previewInto, singlePage, previewPane,
} from './ui.js';
import { ORGANIZE_MORE } from './more/organize.js';
import { SECURITY_MORE } from './more/security.js';
import { TO_PDF } from './more/to-pdf.js';
import { FROM_PDF } from './more/from-pdf.js';
import { SMART } from './more/smart.js';

export const CATEGORIES = [['organize', 'Organize'], ['optimize', 'Optimize'], ['convert', 'Convert'], ['edit', 'Edit'], ['security', 'Security'], ['ai', 'Intelligence'], ['workflows', 'Workflows']];

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
    // Runs of consecutive pages joined by "_": [0,1,2,4] -> "1-3_5", [2,1,0] -> "3-1".
    const label = (ix) => {
      const runs = [];
      for (const i of ix) {
        const r = runs[runs.length - 1];
        if (r && (r.step ? i === r.b + r.step : Math.abs(i - r.b) === 1)) { r.step ||= i - r.b; r.b = i; } else runs.push({ a: i, b: i, step: 0 });
      }
      return runs.map((r) => (r.a === r.b ? `${r.a + 1}` : `${r.a + 1}-${r.b + 1}`)).join('_');
    };
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

// dpi: resolution kept for each image at the size it is drawn on the page.
export const LEVELS = {
  low: { maxSide: 2400, quality: 0.82, dpi: 220 },
  medium: { maxSide: 1600, quality: 0.68, dpi: 150 },
  high: { maxSide: 1100, quality: 0.5, dpi: 96 },
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
    busy('Tidying up…');
    await tick();
    await tidyPdf(lib);
    busy('Saving…');
    await tick();
    const bytes = await lib.save({ useObjectStreams: true });
    const before = doc.size;
    const smaller = bytes.byteLength < before;
    const final = smaller ? bytes : doc.bytes;
    const pct = Math.min(99, Math.round((1 - final.byteLength / before) * 100));
    return {
      files: [pdfOut(`${baseName(doc.name)}-compressed.pdf`, final)],
      title: smaller ? `Your PDF is ${pct}% smaller` : 'This PDF is already compact',
      note: smaller ? `${fmtSize(before)} → ${fmtSize(final.byteLength)}${total ? ` · ${done} of ${total} images made smaller` : ''}` : 'We could not make it smaller without losing quality, so this is your original file.',
    };
  },
};

// Re-encodes photos inside the PDF as smaller JPEGs. Vector text and drawings
// aren't touched. Images we can't decode safely are left as they are.
export async function shrinkImages(lib, { maxSide, quality, dpi }, progress) {
  const { PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } = window.PDFLib;
  const N = (n) => PDFName.of(n);
  const placed = dpi ? placedSizes(lib) : new Map();
  const jobs = [];
  // Soft masks and stencil masks are images too, but they must stay 1-channel
  // and lossless; turning them into RGB JPEGs makes the masked image vanish.
  const masks = new Set();
  for (const [, obj] of lib.context.enumerateIndirectObjects()) {
    const d = obj?.dict;
    if (!d || d.get(N('Subtype'))?.toString() !== '/Image') continue;
    for (const key of ['SMask', 'Mask']) { const v = d.get(N(key)); if (v instanceof PDFRef) masks.add(v.toString()); }
  }
  for (const [ref, obj] of lib.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(N('Subtype'))?.toString() !== '/Image' || masks.has(ref.toString())) continue;
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
      const img = await decodeImage(job.obj, job.w, job.hgt, window.PDFLib, { cmyk: true });
      if (!img) continue;
      let scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      // Keep `dpi` at the largest size the image is drawn (area-based, so a
      // rotated image counts the same).
      const use = placed.get(job.ref.toString());
      if (use) scale = Math.min(scale, Math.max(0.05, Math.sqrt((use.w * use.h * dpi * dpi) / (72 * 72) / (img.width * img.height))));
      const c = document.createElement('canvas');
      const cw = c.width = Math.max(1, Math.round(img.width * scale));
      const ch = c.height = Math.max(1, Math.round(img.height * scale));
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, cw, ch);
      cx.drawImage(img, 0, 0, cw, ch);
      img.close?.();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
      c.width = c.height = 0;
      if (!blob) throw new Error(`image ${job.ref} is too large to re-encode on this device`);
      const jpg = new Uint8Array(await blob.arrayBuffer());
      if (jpg.byteLength >= job.obj.contents.byteLength * 0.97) continue;
      const nd = job.obj.dict.clone(lib.context);
      ['DecodeParms', 'DP', 'Filter', 'F', 'ColorSpace', 'BitsPerComponent', 'Length', 'Intent'].forEach((key) => nd.delete(N(key)));
      nd.set(N('Filter'), N('DCTDecode'));
      nd.set(N('ColorSpace'), N('DeviceRGB'));
      nd.set(N('BitsPerComponent'), PDFNumber.of(8));
      nd.set(N('Width'), PDFNumber.of(cw));
      nd.set(N('Height'), PDFNumber.of(ch));
      lib.context.assign(job.ref, PDFRawStream.of(nd, jpg));
      done++;
    } catch (err) { console.warn('kept image', err); }
  }
  return { done, total: jobs.length };
}

// How big each image is drawn, in points (the largest use wins), keyed by
// its reference. Follows the drawing commands, including inside forms.
function placedSizes(lib) {
  const { PDFName, PDFDict, PDFRef, PDFRawStream, decodePDFRawStream } = window.PDFLib;
  const N = (n) => PDFName.of(n);
  const ctx = lib.context;
  const out = new Map();
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const walk = (ops, resources, base, depth) => {
    const xo = resources instanceof PDFDict ? resources.lookup(N('XObject')) : null;
    if (!(xo instanceof PDFDict) || depth > 8) return;
    let ctm = base;
    const stack = [];
    for (const o of ops) {
      const a = o.args;
      if (o.op === 'q') stack.push(ctm);
      else if (o.op === 'Q') ctm = stack.pop() || base;
      else if (o.op === 'cm' && a.length >= 6 && a.slice(0, 6).every((v) => typeof v === 'number')) ctm = mul(a.slice(0, 6), ctm);
      else if (o.op === 'Do' && a[0]?.name) {
        const ref = xo.get(N(a[0].name));
        const x = ctx.lookup(ref);
        const sub = x?.dict?.get(N('Subtype'))?.toString();
        if (sub === '/Image' && ref instanceof PDFRef) {
          const k = ref.toString(), prev = out.get(k);
          out.set(k, { w: Math.max(Math.hypot(ctm[0], ctm[1]), prev?.w || 0), h: Math.max(Math.hypot(ctm[2], ctm[3]), prev?.h || 0) });
        } else if (sub === '/Form' && x instanceof PDFRawStream) {
          const m = x.dict.lookup(N('Matrix'))?.asArray?.().map((v) => v.asNumber?.() ?? 0);
          let bytes;
          try { bytes = decodePDFRawStream(x).decode(); } catch { continue; }
          walk(parseOps(bytes), x.dict.lookup(N('Resources')) || resources, mul(m?.length === 6 ? m : [1, 0, 0, 1, 0, 0], ctm), depth + 1);
        }
      }
    }
  };
  lib.getPages().forEach((page, i) => {
    try { walk(readPage(lib, i).ops, page.node.Resources(), [1, 0, 0, 1, 0, 0], 0); } catch (err) { console.warn('image sizes', err); }
  });
  return out;
}

// Savings that don't touch how anything looks: one copy of identical streams
// (merged files repeat logos and fonts), deflate for uncompressed streams,
// and no thumbnails, editor private data or objects nothing refers to.
export async function tidyPdf(lib) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream } = window.PDFLib;
  const N = (n) => PDFName.of(n);
  const ctx = lib.context;
  for (const p of lib.getPages()) { p.node.delete(N('Thumb')); p.node.delete(N('PieceInfo')); }
  lib.catalog.delete(N('PieceInfo'));

  // Identical streams -> one.
  const seen = new Map(), dup = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.byteLength < 64) continue;
    const d = obj.dict.clone(ctx);
    d.delete(N('Length'));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', obj.contents)).join(',');
    const key = d.toString() + '|' + hash;
    if (seen.has(key)) dup.set(ref.toString(), seen.get(key));
    else seen.set(key, ref);
  }
  if (dup.size) {
    const fix = (o) => {
      if (o instanceof PDFDict) for (const [k, v] of o.entries()) { if (v instanceof PDFRef && dup.has(v.toString())) o.set(k, dup.get(v.toString())); else fix(v); }
      else if (o instanceof PDFArray) o.asArray().forEach((v, i) => { if (v instanceof PDFRef && dup.has(v.toString())) o.set(i, dup.get(v.toString())); else fix(v); });
      else if (o?.dict instanceof PDFDict) fix(o.dict);
    };
    for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj);
  }

  // Deflate streams stored without any compression.
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.has(N('Filter')) || obj.contents.byteLength < 256) continue;
    const z = ctx.flateStream(obj.contents);
    if (z.contents.byteLength >= obj.contents.byteLength * 0.9) continue;
    const d = obj.dict.clone(ctx);
    d.delete(N('Length'));
    d.delete(N('DecodeParms'));
    d.set(N('Filter'), N('FlateDecode'));
    ctx.assign(ref, PDFRawStream.of(d, z.contents));
  }

  // Keep only what the document can reach.
  const keep = new Set();
  const visit = (o) => {
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (keep.has(k)) return;
      keep.add(k);
      visit(ctx.lookup(o));
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v);
    else if (o instanceof PDFArray) o.asArray().forEach(visit);
    else if (o?.dict instanceof PDFDict) visit(o.dict);
  };
  [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].forEach((r) => r && visit(r));
  for (const [ref] of [...ctx.enumerateIndirectObjects()]) if (!keep.has(ref.toString())) ctx.delete(ref);
}

const RAW_FILTERS = ['/FlateDecode', '/LZWDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/RunLengthDecode'];
const filtersOf = (d, N) => { const f = d.get(N('Filter')); return f ? (f.asArray ? f.asArray().map(String) : [String(f)]) : []; };

// Undoes PNG predictors (Predictor 10-15): every row starts with a filter
// byte. pdf-lib's decoder leaves them in. TIFF predictor 2 is not handled.
function unpredict(data, parms, N) {
  const num = (k, dflt) => parms?.get?.(N(k))?.asNumber?.() ?? dflt;
  const pred = num('Predictor', 1);
  if (pred < 2) return data;
  if (pred < 10) return null;
  const colors = num('Colors', 1), bpc = num('BitsPerComponent', 8), cols = num('Columns', 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * cols) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const s = r * (rowLen + 1) + 1, o = r * rowLen, type = data[s - 1];
    for (let i = 0; i < rowLen; i++) {
      const x = data[s + i], a = i >= bpp ? out[o + i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else return null;
      out[o + i] = v & 255;
    }
    prev = out.subarray(o, o + rowLen);
  }
  return out;
}

// Exactly w*hgt*comps bytes of 8-bit samples from a Flate/LZW/... image, or null.
function rawPixels(stream, w, hgt, comps, { PDFName, PDFDict, decodePDFRawStream }) {
  const N = (n) => PDFName.of(n);
  const d = stream.dict;
  const filters = filtersOf(d, N);
  if (filters.some((f) => !RAW_FILTERS.includes(f))) return null;
  if ((d.get(N('BitsPerComponent'))?.asNumber?.() ?? 8) !== 8) return null;
  let parms = d.lookup(N('DecodeParms')) ?? d.lookup(N('DP'));
  if (parms?.asArray) {
    const k = filters.findIndex((f) => f === '/FlateDecode' || f === '/LZWDecode');
    parms = k < 0 ? undefined : d.context.lookup(parms.asArray()[k]);
  }
  const data = unpredict(decodePDFRawStream(stream).decode(), parms instanceof PDFDict ? parms : undefined, N);
  return data && data.length === w * hgt * comps ? data : null;
}

function componentsOf(d, N) {
  const cs = d.lookup(N('ColorSpace'));
  const csName = cs?.asArray ? String(cs.asArray()[0]) : String(cs);
  if (csName === '/ICCBased') return d.context.lookup(cs.asArray()[1])?.dict?.get(N('N'))?.asNumber?.() || 0;
  return csName === '/DeviceGray' || csName === '/CalGray' ? 1 : csName === '/DeviceRGB' || csName === '/CalRGB' ? 3 : csName === '/DeviceCMYK' ? 4 : 0;
}

// A simple soft mask (8-bit gray, same size, no Matte/Decode) as alpha bytes, or null.
function softMaskAlpha(d, w, hgt, ns) {
  const N = (n) => ns.PDFName.of(n);
  const sm = d.lookup(N('SMask'));
  if (!(sm instanceof ns.PDFRawStream)) return null;
  const md = sm.dict;
  if (md.has(N('Matte')) || md.has(N('Decode')) || componentsOf(md, N) !== 1) return null;
  if (md.get(N('Width'))?.asNumber?.() !== w || md.get(N('Height'))?.asNumber?.() !== hgt) return null;
  try { return rawPixels(sm, w, hgt, 1, ns); } catch { return null; }
}

// Decodes an image XObject into an ImageBitmap the size of its /Width × /Height,
// or null for kinds we don't handle (CMYK, indexed, 16-bit, odd /Decode...).
// alpha: optional w*hgt alpha bytes (from softMaskAlpha).
async function decodeImage(stream, w, hgt, ns, { alpha = null, cmyk = false } = {}) {
  const N = (n) => ns.PDFName.of(n);
  const d = stream.dict;
  const filters = filtersOf(d, N);
  const comps = componentsOf(d, N);
  // CMYK only as a JPEG with Adobe's marker, which browsers decode correctly
  // (print and scanner PDFs); the result becomes an RGB JPEG.
  const adobeCmyk = cmyk && comps === 4 && filters.length === 1 && filters[0] === '/DCTDecode' && !alpha
    && new TextDecoder('latin1').decode(stream.contents.subarray(0, 4096)).includes('Adobe');
  if (comps !== 1 && comps !== 3 && !adobeCmyk) return null;
  // /Decode: the default is fine, an inverted gray image we flip, others we skip.
  let invert = false;
  const dec = d.lookup(N('Decode'))?.asArray?.().map((x) => x.asNumber?.());
  if (dec) {
    if (dec.length === 2 * comps && dec.every((v, i) => v === i % 2)) invert = false;
    else if (comps === 1 && dec[0] === 1 && dec[1] === 0) invert = true;
    else return null;
  }
  let rgba;
  if (filters.length === 1 && filters[0] === '/DCTDecode') {
    // PDF readers ignore EXIF orientation, so must we.
    const bmp = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    if (bmp.width !== w || bmp.height !== hgt) { bmp.close(); return null; }
    if (!invert && !alpha) return bmp;
    const c = document.createElement('canvas');
    c.width = w; c.height = hgt;
    const cx = c.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    bmp.close();
    rgba = cx.getImageData(0, 0, w, hgt).data;
    c.width = c.height = 0;
  } else {
    const data = rawPixels(stream, w, hgt, comps, ns);
    if (!data) return null;
    rgba = new Uint8ClampedArray(w * hgt * 4);
    for (let p = 0, q = 0; p < w * hgt; p++, q += comps) {
      const o = p * 4;
      rgba[o] = data[q]; rgba[o + 1] = data[comps === 3 ? q + 1 : q]; rgba[o + 2] = data[comps === 3 ? q + 2 : q]; rgba[o + 3] = 255;
    }
  }
  if (invert || alpha) for (let p = 0, o = 0; p < w * hgt; p++, o += 4) {
    if (invert) { rgba[o] = 255 - rgba[o]; rgba[o + 1] = 255 - rgba[o + 1]; rgba[o + 2] = 255 - rgba[o + 2]; }
    if (alpha) rgba[o + 3] = alpha[p];
  }
  return createImageBitmap(new ImageData(rgba, w, hgt), { premultiplyAlpha: 'none' });
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
        h('button', { class: 'iconbtn card__x', 'aria-label': `Remove ${it.name}`, onclick: () => { ctx.items.splice(ctx.items.indexOf(it), 1); URL.revokeObjectURL(it.url); draw(); } }, icon('x')),
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

const MAX_SIDE = 8192, MAX_PIXELS = 16e6;

const pdfToJpg = {
  id: 'pdf-to-jpg', keywords: 'image png jpeg convert export extract pictures photos', title: 'PDF to JPG', icon: 'pdfToJpg', color: '#06b6d4', cat: 'convert', action: 'Convert to images', wide: true, busyText: 'Converting…',
  desc: 'Save pages as images, or pull out the pictures inside.',
  long: 'Save PDF pages as JPG or PNG images, or extract the photos inside the PDF. Click pages to leave them out.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { mode: 'pages', format: 'jpg', dpi: 150, skip: new Set() };
    const grid = pageGrid(doc, (cell, i) => {
      cell.classList.add('on');
      cell.append(h('span', { class: 'pg__tick' }, icon('check')));
      cell.addEventListener('click', () => { s.skip.has(i) ? s.skip.delete(i) : s.skip.add(i); cell.classList.toggle('on', !s.skip.has(i)); count(); });
    });
    grid.classList.add('pickable');
    const n = h('p', { class: 'muted' });
    const count = () => {
      const k = doc.pages - s.skip.size;
      n.textContent = s.mode === 'pages' ? `${k} image${k === 1 ? '' : 's'}` : `Images from ${k} page${k === 1 ? '' : 's'}`;
      ctx.action.disabled = !k;
    };
    const format = field('Format', segmented([['jpg', 'JPG'], ['png', 'PNG']], s.format, (v) => (s.format = v)));
    const quality = field('Quality', segmented([[96, 'Small'], [150, 'Normal'], [300, 'High']], s.dpi, (v) => (s.dpi = v)));
    const about = h('p', { class: 'muted small', hidden: true }, 'Photos come out exactly as stored in the PDF (JPG), other pictures as PNG. Icons smaller than 40 px are skipped, and so are a few rare image kinds.');
    ctx.main.append(grid);
    ctx.side.append(
      segmented([['pages', 'Pages to images'], ['images', 'Extract images']], s.mode, (v) => {
        s.mode = v;
        format.hidden = quality.hidden = v !== 'pages';
        about.hidden = v === 'pages';
        ctx.action.firstChild.textContent = v === 'pages' ? 'Convert to images' : 'Extract images';
        count();
      }),
      format, quality, about, n);
    count();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    const want = [...Array(doc.pages).keys()].filter((i) => !s.skip.has(i));
    if (s.mode === 'images') return this.extract(doc, want);
    const files = [];
    const lowered = [];
    for (const [k, i] of want.entries()) {
      busy(`Page ${k + 1} of ${want.length}…`);
      // Canvases have size limits (about 16 MP on phones): big pages get a lower resolution.
      const pg = await doc.js.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1 });
      const want0 = s.dpi / 72;
      const scale = Math.min(want0, MAX_SIDE / vp.width, MAX_SIDE / vp.height, Math.sqrt(MAX_PIXELS / (vp.width * vp.height)));
      if (scale < want0 * 0.999) lowered.push(i + 1);
      const c = await renderPage(doc.js, i, 0, { lazy: false, scale });
      if (s.format === 'jpg') { // JPG has no transparency; keep paper white
        const x = c.getContext('2d');
        x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      }
      const blob = await new Promise((r) => c.toBlob(r, s.format === 'jpg' ? 'image/jpeg' : 'image/png', 0.9));
      c.width = c.height = 0;
      if (!blob) throw new Error(`Page ${i + 1} is too large to save as an image on this device. Try a lower quality.`);
      files.push({ name: `${baseName(doc.name)}-page-${i + 1}.${s.format}`, bytes: blob, type: blob.type });
    }
    const note = lowered.length ? `Page${lowered.length === 1 ? '' : 's'} ${lowered.length > 5 ? lowered.slice(0, 5).join(', ') + '…' : lowered.join(', ')} ${lowered.length === 1 ? 'is' : 'are'} too big for ${s.dpi} dpi, so ${lowered.length === 1 ? 'it was' : 'they were'} saved at a lower resolution.` : undefined;
    return { files, note, zipName: `${baseName(doc.name)}-images.zip`, title: files.length > 1 ? `${files.length} images are ready` : 'Your image is ready' };
  },
  // Pulls the image objects out of the chosen pages (and the forms they
  // draw), each once. JPEGs are copied byte for byte; the rest go through
  // decodeImage, which handles 8-bit gray and RGB, and are saved as PNG.
  async extract(doc, want) {
    const { PDFName, PDFDict, PDFRawStream, PDFRef } = window.PDFLib;
    const N = (n) => PDFName.of(n);
    const lib = await loadLib(doc);
    const found = [];
    const seen = new Set();
    const walk = (resources) => {
      const xobjects = resources instanceof PDFDict && resources.lookup(N('XObject'));
      if (!(xobjects instanceof PDFDict)) return;
      for (const [, ref] of xobjects.entries()) {
        const key = ref instanceof PDFRef ? ref.toString() : ref;
        if (seen.has(key)) continue;
        seen.add(key);
        const obj = lib.context.lookup(ref);
        if (!(obj instanceof PDFRawStream)) continue;
        const type = obj.dict.get(N('Subtype'))?.toString();
        if (type === '/Image') found.push(obj);
        else if (type === '/Form') walk(obj.dict.lookup(N('Resources')));
      }
    };
    want.forEach((i) => walk(lib.getPage(i).node.Resources()));
    const files = [];
    let skipped = 0;
    for (const [k, obj] of found.entries()) {
      busy(`Image ${k + 1} of ${found.length}…`);
      await tick();
      const d = obj.dict;
      const w = d.get(N('Width'))?.asNumber?.() || 0;
      const hgt = d.get(N('Height'))?.asNumber?.() || 0;
      if (w < 40 || hgt < 40) continue;
      const filters = filtersOf(d, N);
      const name = `${baseName(doc.name)}-image-${files.length + 1}`;
      const jpeg = filters.length === 1 && filters[0] === '/DCTDecode';
      let alpha = null;
      try { alpha = softMaskAlpha(d, w, hgt, window.PDFLib); } catch { /* no transparency then */ }
      // Plain JPEGs are copied as they are; with a soft mask or an inverting
      // /Decode they go through decodeImage and come out as PNG.
      if (jpeg && !alpha && !d.has(N('Decode'))) {
        files.push({ name: name + '.jpg', bytes: obj.contents, type: 'image/jpeg' });
        continue;
      }
      let img = null;
      try { img = d.get(N('ImageMask'))?.toString() === 'true' ? null : await decodeImage(obj, w, hgt, window.PDFLib, { alpha }); } catch (err) { console.warn('skipped image', err); }
      if (!img && jpeg) { // e.g. CMYK: the stored JPEG still opens in image viewers
        files.push({ name: name + '.jpg', bytes: obj.contents, type: 'image/jpeg' });
        continue;
      }
      if (!img) { skipped++; continue; }
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      img.close?.();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      c.width = c.height = 0;
      if (!blob) { skipped++; continue; }
      files.push({ name: name + '.png', bytes: blob, type: 'image/png' });
    }
    if (!files.length) throw new Error(skipped ? 'The images on these pages are in a kind this tool can’t save yet.' : 'No pictures found on these pages. Try “Pages to images” instead.');
    return {
      files, zipName: `${baseName(doc.name)}-extracted-images.zip`,
      title: files.length > 1 ? `${files.length} images extracted` : 'Your image is extracted',
      note: skipped ? `${skipped} image${skipped === 1 ? '' : 's'} in a rarer format could not be saved.` : undefined,
    };
  },
};

/* ---------- WATERMARK ---------- */

// A "which pages" box that says under itself when it can't be read, and
// keeps the action button off until it can.
function pagesField(label, doc, placeholder, ctx, onChange) {
  const err = h('p', { class: 'muted small bad', hidden: true });
  const input = h('input', { class: 'field', placeholder, oninput: (e) => {
    const v = e.target.value;
    let msg = '';
    if (v.trim()) { try { parseRanges(v, doc.pages); } catch (x) { msg = x.message; } }
    err.textContent = msg; err.hidden = !msg;
    ctx.action.disabled = !!msg;
    onChange(v);
  } });
  return [field(label, input), err];
}

const POS9 = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];

const watermark = {
  id: 'watermark', keywords: 'stamp logo brand', title: 'Add watermark', icon: 'watermark', color: '#e07a52', cat: 'edit', action: 'Add watermark', wide: true,
  desc: 'Stamp text or a logo across your pages.',
  long: 'Stamp text or an image on your pages. Choose where, how big and how see-through.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { kind: 'text', text: 'CONFIDENTIAL', size: 60, color: '#e11d48', opacity: 0.3, angle: 45, pos: 'mc', tile: false, img: null, imgScale: 40, pages: '' };
    const preview = previewPane(doc, (lib, idx, real) => {
      let only = null;
      try { if (s.pages.trim()) only = parseRanges(s.pages, doc.pages); } catch { /* shown under the field */ }
      if (only && !only.includes(real)) return undefined; // this page won't be stamped
      return stampWatermark(lib, idx, s);
    });
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
      ...pagesField('Pages (empty = all)', doc, `e.g. 1-${doc.pages}`, ctx, (v) => { s.pages = v; up(); }));
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

export async function stampWatermark(lib, indexes, s) {
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
        field('First number', h('input', { class: 'field', type: 'number', min: 0, value: 1, oninput: (e) => { s.start = Math.max(0, parseInt(e.target.value, 10) || 0); up(); } })),
        field('Text size', h('input', { class: 'field', type: 'number', min: 6, max: 48, value: s.size, oninput: (e) => { s.size = Math.min(48, Math.max(6, +e.target.value || 11)); up(); } }))),
      field('Colour', h('input', { type: 'color', class: 'swatch', value: s.color, oninput: (e) => { s.color = e.target.value; up(); } })),
      ...pagesField('Pages to number (empty = all)', doc, `e.g. 2-${doc.pages}`, ctx, (v) => { s.pages = v; up(); }));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    if (ctx.state.pages.trim()) parseRanges(ctx.state.pages, doc.pages); // a range we can't read is an error, not "all pages"
    const lib = await loadLib(doc);
    await stampNumbers(lib, lib.getPageIndices(), ctx.state);
    return { files: [pdfOut(`${baseName(doc.name)}-numbered.pdf`, await lib.save())] };
  },
};

// indexes: pages of `lib` to stamp. realIndex: for previews, which page of the
// original file `lib`'s single page is.
export async function stampNumbers(lib, indexes, s, realIndex) {
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

// Same order as iLovePDF's menu. Ids not listed go at the end.
const ORDER = [
  'merge', 'split', 'remove-pages', 'extract-pages', 'organize', 'scan',
  'compress', 'repair', 'ocr', 'image-to-text',
  'jpg-to-pdf', 'word-to-pdf', 'ppt-to-pdf', 'excel-to-pdf', 'html-to-pdf',
  'pdf-to-jpg', 'pdf-to-word', 'pdf-to-ppt', 'pdf-to-excel', 'pdf-to-pdfa', 'pdf-to-markdown',
  'rotate', 'page-numbers', 'watermark', 'crop', 'edit', 'forms',
  'unlock', 'protect', 'sign', 'redact', 'compare',
  'summarize', 'translate', 'workflow',
];
const rank = (t) => (ORDER.includes(t.id) ? ORDER.indexOf(t.id) : ORDER.length);
export const TOOLS = [
  merge, split, organize, rotate, compress, jpgToPdf, pdfToJpg,
  editorTool('edit'), editorTool('sign'), watermark, pageNumbers, protect, unlock,
  ...ORGANIZE_MORE, ...SECURITY_MORE, ...TO_PDF, ...FROM_PDF, ...SMART,
].sort((a, b) => rank(a) - rank(b));
