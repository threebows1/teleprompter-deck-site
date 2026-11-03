// Edit PDF and Sign PDF: put text, signatures, images, pen strokes,
// highlights and white-out boxes on the pages, then write them into the file.
//
// Everything is kept in "view points": PDF points measured from the top-left
// of the page as it is shown (after its /Rotate). pageFrame() turns those into
// real PDF coordinates when saving.
import {
  h, icon, busy, tick, StandardFonts, degrees, BlendMode, loadLib, renderPage, baseName, pageSizes,
  pageFrame, boxAnchor, fontCanDraw, textAsPng, hexToRgb, imageForPdf, pickFiles, modal, STAY, uid, toast,
} from './core.js';
import { readPage, matchItems, dropOps, plan, invisibleShows } from './content.js';
import { langPicker, ocrWorker } from './more/security.js';

const FONTS = {
  Helvetica: { label: 'Sans (Helvetica)', css: 'Helvetica, Arial, sans-serif', std: ['Helvetica', 'HelveticaBold'], base: 0.947 },
  Times: { label: 'Serif (Times)', css: '"Times New Roman", Times, serif', std: ['TimesRoman', 'TimesRomanBold'], base: 0.938 },
  Courier: { label: 'Mono (Courier)', css: '"Courier New", Courier, monospace', std: ['Courier', 'CourierBold'], base: 0.867 },
};
const LH = 1.2; // text line height, in em
const SIG_KEY = 'pdftools.signatures';

const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } };
const saveSigs = (list) => { try { localStorage.setItem(SIG_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* private mode */ } };

export function editorTool(mode) {
  const sign = mode === 'sign';
  return {
    id: mode, cat: 'edit', wide: true, editor: true, keywords: sign ? 'signature esign initials date' : 'text change write image draw highlight whiteout',
    title: sign ? 'Sign PDF' : 'Edit PDF',
    icon: sign ? 'sign' : 'edit',
    color: sign ? '#7c3aed' : '#6646e8',
    action: sign ? 'Sign and save' : 'Save PDF',
    busyText: 'Saving…',
    desc: sign ? 'Draw, type or upload your signature and place it on the page.' : 'Change, move or delete the text in a PDF, and add text, images and drawings.',
    long: sign
      ? 'Make your signature once, then click on the page to place it. Add the date or your name the same way.'
      : 'Click any text in the PDF to change it, drag it to move it, or delete it. Add new text, images, your signature, drawings and highlights.',
    setup: (ctx) => setupEditor(ctx, sign),
    run: (ctx) => saveEditor(ctx),
  };
}

/* ---------- setup ---------- */

async function setupEditor(ctx, signMode) {
  const doc = ctx.items[0];
  const sizes = await pageSizes(doc.js);
  if (!ctx.main.isConnected) return; // left while the pages were measured
  const st = ctx.state = {
    doc, sizes, objects: [], history: [], tool: signMode ? 'select' : 'edittext', selected: null, editing: null, pending: null, scale: 1,
    texts: [], // per page: the PDF's own text, once read (see readText)
    removed: new Map(), // "page:item" -> mask colour, for original text taken out
    text: { font: 'Helvetica', size: 14, color: '#111827', bold: false, align: 'left' },
    pen: { color: '#1d4ed8', width: 2 },
    mark: { color: '#fde047' },
    white: { color: '#ffffff' },
  };
  const els = new Map(); // object id -> element

  /* toolbar */
  const tools = signMode
    ? [['select', 'cursor', 'Select'], ['sign', 'sign', 'Signature'], ['text', 'text', 'Text'], ['date', 'numbers', 'Date'], ['image', 'image', 'Image']]
    : [['edittext', 'edit', 'Edit text'], ['select', 'cursor', 'Select'], ['text', 'text', 'Add text'], ['sign', 'sign', 'Signature'], ['image', 'image', 'Image'], ['draw', 'pen', 'Draw'], ['highlight', 'highlight', 'Highlight'], ['whiteout', 'whiteout', 'White-out']];
  // Left rail of tools (a scrolling strip on phones).
  const rail = h('nav', { class: 'ed-rail', role: 'toolbar', 'aria-label': 'Editing tools' });
  const toolBtns = tools.map(([id, ic, label]) =>
    h('button', { class: 'ed-tool', 'data-tool': id, title: label, onclick: () => pickTool(id) }, icon(ic), h('span', {}, label)));
  rail.append(...toolBtns);

  // Top bar over the document: where you are, undo, zoom.
  const zoomOut = h('button', { class: 'iconbtn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoom(1 / 1.2) }, '−');
  const zoomIn = h('button', { class: 'iconbtn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoom(1.2) }, '+');
  const undoBtn = h('button', { class: 'iconbtn', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => undo() }, icon('undo'));
  const zoomLbl = h('span', { class: 'ed-zoomlbl', 'aria-live': 'polite' });
  const pageLbl = h('span', { class: 'ed-where' });
  const top = h('div', { class: 'ed-top' },
    h('div', { class: 'ed-doc' }, h('span', { class: 'ed-doc__tag' }, 'PDF'), h('strong', { title: doc.name }, doc.name), pageLbl),
    h('div', { class: 'ed-zoom' }, undoBtn, h('span', { class: 'ed-sep' }), zoomOut, zoomLbl, zoomIn));

  /* pages */
  const pagesEl = h('div', { class: 'ed-pages' });
  const pageEls = sizes.map((sz, i) => {
    const canvas = h('canvas');
    const layer = h('div', { class: 'ed-layer', 'data-page': i });
    const wrap = h('div', { class: 'ed-page', 'data-page': i }, canvas, layer);
    wrap.canvas = canvas; wrap.layer = layer; wrap.rendered = 0;
    pagesEl.append(wrap);
    return wrap;
  });

  // Page thumbnails: click to jump, the current one is marked.
  const thumbs = h('div', { class: 'ed-thumbs' }, h('p', { class: 'f__label' }, 'Pages'));
  const thumbBtns = sizes.map((sz, i) => {
    const c = h('canvas', { class: 'thumb' });
    renderPage(doc.js, i, 88, { canvas: c }).catch(() => {});
    const b = h('button', { class: 'ed-thumb', 'aria-label': `Go to page ${i + 1}`, onclick: () => pagesEl.scrollTo({ top: pageEls[i].offsetTop - 16, behavior: 'smooth' }) },
      h('span', { class: 'ed-thumb__page' }, c), h('span', { class: 'ed-thumb__num' }, String(i + 1).padStart(2, '0')));
    thumbs.append(b);
    return b;
  });
  const markCurrent = () => {
    const mid = pagesEl.scrollTop + pagesEl.clientHeight / 3;
    let cur = 0;
    pageEls.forEach((p, i) => { if (p.offsetTop <= mid) cur = i; });
    thumbBtns.forEach((b, i) => b.classList.toggle('on', i === cur));
    pageLbl.textContent = `Page ${cur + 1} of ${sizes.length}`;
    if (st.curPage !== cur) { st.curPage = cur; thumbBtns[cur].scrollIntoView({ block: 'nearest' }); }
  };
  pagesEl.addEventListener('scroll', () => requestAnimationFrame(markCurrent), { passive: true });

  ctx.main.append(h('div', { class: 'ed-shell' + (sizes.length < 2 ? ' ed-shell--one' : '') }, rail, thumbs, h('div', { class: 'ed-stage' }, top, pagesEl)));
  setTimeout(markCurrent, 0);

  // Draw pages only when they scroll into view.
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) paintPage(+en.target.dataset.page);
  }), { rootMargin: '600px 0px' });
  pageEls.forEach((p) => io.observe(p));

  // Once the editor is off the page (another tool, Change file, saved), stop
  // everything it started, or the observers go on drawing every page.
  const gone = () => {
    if (pagesEl.isConnected) return false;
    if (!st.closed) {
      st.closed = true;
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('keydown', onKey);
      st.images?.forEach((_, src) => URL.revokeObjectURL(src));
      st.ocr?.worker?.then((w) => w.terminate(), () => {});
    }
    return true;
  };

  async function paintPage(i) {
    const p = pageEls[i];
    if (p.rendered === st.scale || gone()) return;
    p.rendered = st.scale;
    await renderPage(doc.js, i, sizes[i].w * st.scale, { canvas: p.canvas }).catch(() => {});
    if (!signMode && !gone()) showBoxes(i).catch((err) => textFailed(err));
  }
  // The PDF's own text could not be read (pdf-lib can't open the file).
  function textFailed(err) {
    console.warn(err);
    if (st.warnedText) return;
    st.warnedText = true;
    toast(err?.message || 'The text in this PDF can’t be edited. You can still add things on top.', 'bad');
  }

  function layout() {
    if (gone()) return 0;
    const avail = Math.max(280, pagesEl.clientWidth - 24);
    pageEls.forEach((p, i) => {
      const { w, h: hh } = sizes[i];
      p.style.width = w * st.scale + 'px';
      p.style.height = hh * st.scale + 'px';
      p.canvas.style.width = '100%';
      p.canvas.style.height = '100%';
      if (p.getBoundingClientRect().top < window.innerHeight + 600 && p.getBoundingClientRect().bottom > -600) paintPage(i);
    });
    st.objects.forEach(place);
    pageEls.forEach((p) => p.layer.querySelectorAll('.tx, .mask').forEach(placeBox));
    zoomLbl.textContent = Math.round(st.scale * 100) + '%';
    return avail;
  }
  function fitWidth() {
    const avail = Math.max(280, pagesEl.clientWidth - 24);
    // Fit the usual page width; an odd wide page scrolls sideways.
    const ws = sizes.map((s) => s.w).sort((a, b) => a - b);
    st.scale = Math.min(1.25, avail / ws[Math.floor((ws.length - 1) / 2)]);
    layout();
  }
  function zoom(k) {
    st.scale = Math.min(4, Math.max(0.3, st.scale * k));
    layout();
  }
  const ro = new ResizeObserver(() => { if (!gone() && !st.userZoom) fitWidth(); });
  ro.observe(pagesEl);
  zoomIn.addEventListener('click', () => (st.userZoom = true));
  zoomOut.addEventListener('click', () => (st.userZoom = true));

  /* side panel */
  const props = h('div', { class: 'ed-props' });
  const sigList = h('div', { class: 'sigs' });
  ctx.side.append(
    signMode && h('div', {},
      h('p', { class: 'f__label' }, 'Your signatures'),
      sigList,
      h('button', { class: 'btn btn--ghost btn--block', onclick: () => newSignature() }, icon('plus'), 'New signature'),
      h('p', { class: 'muted small' }, 'Pick a signature, then click on the page where it goes. Drag to move it, use the corner to resize.')),
    props);

  function drawSigs() {
    const list = loadSigs();
    sigList.replaceChildren(...list.map((src, k) => h('div', { class: 'sig' + (st.pending?.src === src ? ' on' : '') },
      h('button', { class: 'sig__use', title: 'Place this signature', onclick: () => armImage(src, 'sig') }, h('img', { src, alt: 'Signature' })),
      h('button', { class: 'iconbtn sig__x', 'aria-label': 'Forget this signature', onclick: () => { const l = loadSigs(); l.splice(k, 1); saveSigs(l); drawSigs(); } }, icon('x')))));
    if (!list.length) sigList.append(h('p', { class: 'muted small' }, 'No signature yet.'));
  }
  if (signMode) drawSigs();

  // Colour dots plus a "custom" dot that opens the system picker.
  // onPick(colour, quiet): quiet is true for the 2nd, 3rd… live update while
  // the picker is being dragged, so one pick is one undo step.
  const swatches = (value, palette, onPick) => {
    const wrap = h('div', { class: 'dots', role: 'radiogroup', 'aria-label': 'Colour' });
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    let live = false;
    const draw = (v) => wrap.replaceChildren(
      ...palette.map((c) => h('button', { type: 'button', class: 'dot' + (same(c, v) ? ' on' : ''), style: { background: c }, role: 'radio', 'aria-checked': String(same(c, v)), 'aria-label': c, onclick: () => { onPick(c, false); draw(c); } })),
      h('label', { class: 'dot dot--custom' + (palette.some((c) => same(c, v)) ? '' : ' on'), title: 'Custom colour', style: { '--v': v } },
        h('input', { type: 'color', value: v, 'aria-label': 'Custom colour', oninput: (e) => { onPick(e.target.value, live); live = true; }, onchange: (e) => { if (!live) onPick(e.target.value, false); live = false; draw(e.target.value); } })));
    draw(value);
    return wrap;
  };
  const INK = ['#111827', '#6646e8', '#14b8a6', '#f43f5e', '#2563eb', '#9ca3af'];
  const MARK = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74'];
  const PAPER = ['#ffffff', '#f8fafc', '#fef9c3', '#e5e7eb', '#000000'];
  const field2 = (label, ...control) => h('div', { class: 'f' }, h('span', { class: 'f__label' }, label), ...control);

  function drawProps() {
    const o = st.selected && st.objects.find((x) => x.id === st.selected);
    const type = o?.type || ({ text: 'text', date: 'text', draw: 'path', highlight: 'rect', whiteout: 'rect' })[st.tool];
    const kids = [];
    if (type === 'text') {
      const t = o || st.text;
      const set = (k, v, quiet) => { if (o) { if (!quiet) snapshot(); o[k] = v; restyle(o); } st.text[k] = v; };
      const align = t.align || 'left';
      kids.push(
        h('h3', { class: 'props__title' }, o?.orig ? 'Text from the PDF' : 'Text properties'),
        field2('Typeface', h('select', { class: 'field', 'aria-label': 'Typeface', onchange: (e) => set('font', e.target.value) },
          Object.keys(FONTS).map((f) => h('option', { value: f, selected: f === t.font }, FONTS[f].label)))),
        h('div', { class: 'row2' },
          field2('Font size', h('div', { class: 'unit' }, h('input', { class: 'field', type: 'number', min: 6, max: 144, step: 0.5, value: t.size, 'aria-label': 'Font size', onchange: (e) => set('size', Math.min(144, Math.max(6, +e.target.value || 14))) }), h('span', {}, 'pt'))),
          field2('Style', h('button', { type: 'button', class: 'btn btn--soft btn--block' + (t.bold ? ' on' : ''), 'aria-pressed': String(!!t.bold), onclick: (e) => { set('bold', !t.bold); e.currentTarget.classList.toggle('on'); } }, h('b', {}, 'B'), 'Bold'))),
        field2('Text color', swatches(t.color, INK, (c, quiet) => set('color', c, quiet))),
        field2('Alignment', h('div', { class: 'seg seg--icons' }, [['left', 'alignLeft', 'Left'], ['center', 'alignCenter', 'Center'], ['right', 'alignRight', 'Right']].map(([v, ic, label]) =>
          h('button', { type: 'button', class: v === align ? 'on' : '', 'aria-pressed': String(v === align), onclick: () => { set('align', v); drawProps(); } }, icon(ic), label)))));
    } else if (type === 'path') {
      const t = o || st.pen;
      kids.push(h('h3', { class: 'props__title' }, 'Pen'),
        field2('Ink color', swatches(t.color, INK, (c, quiet) => { st.pen.color = c; if (o) { if (!quiet) snapshot(); o.color = c; restyle(o); } })),
        field2('Thickness', h('div', { class: 'seg' }, [[1, 'Thin'], [2, 'Normal'], [4, 'Thick'], [8, 'Marker']].map(([v, l]) =>
          h('button', { type: 'button', class: v === t.width ? 'on' : '', onclick: () => { st.pen.width = v; if (o) { snapshot(); o.width = v; restyle(o); } drawProps(); } }, l)))));
    } else if (type === 'rect') {
      const which = o ? o.kind : st.tool;
      const hl = which === 'highlight';
      const t = o || (hl ? st.mark : st.white);
      kids.push(h('h3', { class: 'props__title' }, hl ? 'Highlight' : 'White-out'),
        field2(hl ? 'Marker color' : 'Cover color', swatches(t.color, hl ? MARK : PAPER, (c, quiet) => { (hl ? st.mark : st.white).color = c; if (o) { if (!quiet) snapshot(); o.color = c; restyle(o); } })),
        !o && h('p', { class: 'muted small' }, 'Drag across the page to draw the box.'));
    } else if (o?.type === 'image') {
      kids.push(h('h3', { class: 'props__title' }, o.kind === 'sig' ? 'Signature' : 'Image'),
        h('p', { class: 'muted small' }, 'Drag to move it. Drag the corner handle to resize it.'));
    }
    if (!o && st.tool === 'edittext') kids.push(h('h3', { class: 'props__title' }, 'Edit text'), h('p', { class: 'muted small' }, 'Every piece of text in the PDF has a box around it. Click one to type over it, or drag it somewhere else. To delete it, click it and clear the text. On a scanned page, press “Make the text on this page editable” first.'));
    if (!o && st.tool === 'select' && !signMode) kids.push(h('h3', { class: 'props__title' }, 'Select'), h('p', { class: 'muted small' }, 'Click something you added to move, resize or change it.'));
    // Without a mouse: put the signature, image or new text in the middle of
    // the page in view (then move it with the arrow keys).
    if (!o && (st.pending || st.tool === 'text' || st.tool === 'date')) {
      kids.push(h('button', { class: 'btn btn--soft btn--block ed-place', onclick: () => placeCentre() }, icon('plus'),
        st.pending ? (st.pending.kind === 'sig' ? 'Place signature on this page' : 'Place image on this page') : 'Add text on this page'));
    }
    if (o) kids.push(h('p', { class: 'muted small' }, 'Arrow keys move it (Shift for bigger steps).'),
      h('button', { class: 'btn btn--soft btn--block danger', onclick: () => remove(o) }, icon('trash'), 'Delete'));
    props.replaceChildren(...kids);
  }

  /* tools */
  function pickTool(id) {
    if (id === 'image') return addImage();
    if (id === 'sign') {
      if (!loadSigs().length) return newSignature();
      if (!signMode) return chooseSignature();
      return armImage(loadSigs()[0], 'sig');
    }
    st.tool = id;
    st.pending = null;
    if (id !== 'select') select(null);
    syncTools();
  }
  function syncTools() {
    toolBtns.forEach((b) => b.classList.toggle('on', b.dataset.tool === (st.pending ? (st.pending.kind === 'sig' ? 'sign' : 'image') : st.tool)));
    pagesEl.dataset.tool = st.pending ? 'place' : st.tool;
    if (signMode) drawSigs();
    drawProps();
  }
  function armImage(src, kind) {
    st.pending = { src, kind };
    st.tool = 'select';
    select(null);
    syncTools();
    toast(kind === 'sig' ? 'Click on the page where the signature goes.' : 'Click on the page where the image goes.');
  }
  async function addImage() {
    const [f] = await pickFiles({ accept: 'image/*' });
    if (!f) return;
    const im = await imageForPdf(f, { maxSide: 2000 });
    const src = URL.createObjectURL(new Blob([im.bytes], { type: im.png ? 'image/png' : 'image/jpeg' }));
    st.images ||= new Map();
    st.images.set(src, im);
    armImage(src, 'img');
  }
  async function chooseSignature() {
    const list = loadSigs();
    const picked = await modal({
      title: 'Choose a signature',
      body: (m) => {
        let choice = list[0];
        m.value = () => choice;
        const g = h('div', { class: 'sigs sigs--pick' }, list.map((src) => h('button', { class: 'sig__use' + (src === choice ? ' on' : ''), onclick: (e) => { choice = src; g.querySelectorAll('.sig__use').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, h('img', { src, alt: 'Signature' }))));
        return [g, h('button', { class: 'linkbtn', onclick: () => { m.cancel(); newSignature(); } }, 'Make a new signature')];
      },
      okText: 'Use it',
    });
    if (picked) armImage(picked, 'sig');
  }
  async function newSignature() {
    const src = await signatureDialog();
    if (!src) return;
    const list = loadSigs().filter((s) => s !== src);
    list.unshift(src);
    saveSigs(list);
    armImage(src, 'sig');
  }

  /* the PDF's own text */

  // Reads page i's text with pdf.js (what it says, where, how big) and the
  // page's drawing commands with content.js (which command draws it).
  function readText(i) {
    if (st.texts[i]) return st.texts[i];
    st.texts[i] = (async () => {
      // One pdf-lib copy for all pages: several pages are read at once.
      st.libP ||= loadLib(doc);
      st.lib = await st.libP;
      const page = await doc.js.getPage(i + 1);
      const tc = await page.getTextContent();
      await page.getOperatorList(); // makes the fonts' real names available
      const vp = page.getViewport({ scale: 1 });
      const items = tc.items.filter((it) => typeof it.str === 'string');
      try {
        const read = readPage(st.lib, i);
        matchItems(items, read.shows);
        // Invisible text (an OCR layer over a scan): taking out its commands
        // leaves the picture of the words, so saving has to cover that too.
        const hidden = invisibleShows(read.ops);
        items.forEach((it) => { it.hidden = it.own.length > 0 && it.own.every((k) => hidden.has(k)); });
      } catch (err) {
        console.warn('content stream', err);
        items.forEach((it) => { it.own = []; it.parent = -1; it.color = '#000000'; });
      }
      items.forEach((it, j) => {
        it.key = `${i}:${j}`;
        const tx = window.pdfjsLib.Util.transform(vp.transform, it.transform);
        const size = Math.hypot(tx[2], tx[3]);
        it.upright = size > 0 && Math.abs(tx[1]) < 0.01 * size && Math.abs(tx[2]) < 0.01 * size && tx[0] > 0 && tx[3] < 0;
        let name = '';
        try { name = page.commonObjs.get(it.fontName)?.name || ''; } catch { /* not loaded */ }
        const family = tc.styles[it.fontName]?.fontFamily;
        it.font = /times|roman|georgia|garamond|cambria|minion|antiqua|bookman|palatino/i.test(name) || family === 'serif' ? 'Times'
          : /courier|mono|consol/i.test(name) || family === 'monospace' ? 'Courier' : 'Helvetica';
        it.bold = /bold|black|heavy|semibold|demi/i.test(name);
        it.size = size;
        it.box = { x: tx[4], y: tx[5] - size * 0.84, w: Math.max(it.width, size * 0.3), h: size * 1.1, base: tx[5] };
      });
      return items;
    })();
    return st.texts[i];
  }

  async function showBoxes(i) {
    const items = await readText(i);
    const layer = pageEls[i].layer;
    layer.querySelectorAll('.tx').forEach((b) => b.remove());
    for (const it of items) {
      if (!it.upright || !it.str.trim() || st.removed.has(it.key)) continue;
      const b = h('div', {
        class: 'tx', 'data-key': it.key, title: 'Click to edit, drag to move', 'aria-label': it.str, 'aria-roledescription': 'editable text', role: 'button', tabindex: '0',
        // Keyboard: Enter or Space turns it into editable text, like a click.
        onkeydown: (e) => {
          if ((e.key !== 'Enter' && e.key !== ' ') || st.tool !== 'edittext') return;
          e.preventDefault();
          takeText(i, it.key).then((o) => editText(o));
        },
      });
      b.box = it.box;
      layer.prepend(b);
      placeBox(b);
    }
    layer.querySelector('.ed-scan')?.remove();
    if (!items.some((it) => it.str.trim())) {
      // A scan or a photo: offer to read its words so they can be edited.
      const btn = h('button', { type: 'button', class: 'ed-scan', onclick: () => readScan(i) }, icon('edit'), 'Make the text on this page editable');
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      layer.append(btn);
      if (!st.warnedScan && st.tool === 'edittext') {
        st.warnedScan = true;
        toast(`Page ${i + 1} is a picture (a scan or photo), so its words are not text yet. Press “Make the text on this page editable” to read them.`);
      }
    }
  }

  // Reads the words in a scanned page with OCR and makes each line editable.
  // Saving covers the old words with the paper's colour and writes the new
  // text on top; the rest of the picture stays as it was.
  async function readScan(i) {
    if (!st.ocr) {
      const s = {};
      const langs = langPicker(s);
      const go = await modal({
        title: 'Make the text editable',
        body: () => [h('p', {}, 'This page is a picture, so its words have to be read first. Then click any line to change, move or delete it.'), langs.el, langs.note],
        okText: 'Read the text',
      });
      if (!go || !s.langs.length) return;
      st.ocr = { langs: s.langs };
    }
    let items = [];
    try {
      const label = sizes.length > 1 ? `Reading page ${i + 1}…` : 'Reading the page…';
      st.ocr.worker ||= ocrWorker(st.ocr.langs, () => label);
      const worker = await st.ocr.worker;
      busy(label);
      // About 300 dpi, but no bigger than Tesseract handles comfortably.
      const scale = Math.min(300 / 72, 4200 / Math.max(sizes[i].w, sizes[i].h));
      const canvas = await renderPage(doc.js, i, 0, { lazy: false, scale });
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      items = scanLines(data, canvas, canvas.width / sizes[i].w, i);
      canvas.width = canvas.height = 0;
    } catch (err) {
      console.error(err);
      st.ocr.worker = null;
      toast(err?.message || 'Could not read this page.', 'bad');
      return;
    } finally { busy(false); }
    if (gone()) return;
    if (!items.length) return toast('No text was found on this page. It may be blurry, or in a language you did not pick.', 'bad');
    st.texts[i] = Promise.resolve(items);
    await showBoxes(i);
    pickTool('edittext');
    toast(`Found ${items.length} line${items.length > 1 ? 's' : ''} of text. Click one to change it.`);
  }
  // Tesseract's lines as editable text items, in view points. `k` is canvas
  // pixels per point.
  function scanLines(data, canvas, k, i) {
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `100px ${FONTS.Helvetica.css}`;
    const out = [];
    for (const block of data.blocks || []) for (const para of block.paragraphs) for (const line of para.lines) {
      const words = line.words.filter((w) => w.confidence >= 30 && w.text.trim());
      if (!words.length) continue;
      const str = words.map((w) => w.text.trim()).join(' ');
      const b = { x0: Math.min(...words.map((w) => w.bbox.x0)), x1: Math.max(...words.map((w) => w.bbox.x1)), y0: Math.min(...words.map((w) => w.bbox.y0)), y1: Math.max(...words.map((w) => w.bbox.y1)) };
      const ra = line.rowAttributes || {};
      const row = (ra.rowHeight || ra.row_height || b.y1 - b.y0) / k;
      const bl = line.baseline;
      const basePx = bl && bl.x1 > bl.x0 ? bl.y0 + ((bl.y1 - bl.y0) * (b.x0 - bl.x0)) / (bl.x1 - bl.x0) : b.y1 - row * k * 0.2;
      const w = (b.x1 - b.x0) / k;
      // The size that makes the line as wide in Helvetica as in the scan,
      // kept near the line's height.
      const fit = (100 * w) / (meas.measureText(str).width || 1);
      const size = clamp(fit, row * 0.6, row * 1.25);
      const base = basePx / k;
      out.push({
        str, width: w, size, font: 'Helvetica', bold: false, upright: true, ocr: true, own: [], parent: -1,
        color: inkColor(cx, b),
        key: `${i}:${out.length}`,
        box: { x: b.x0 / k, y: Math.min(b.y0 / k, base - size * 0.84), w, h: Math.max((b.y1 - b.y0) / k, base - b.y0 / k + size * 0.22), base },
      });
    }
    return out;
  }
  // The colour of the letters in a box of the canvas: the darkest pixels.
  function inkColor(cx, b) {
    const x = Math.max(0, Math.floor(b.x0)), y = Math.max(0, Math.floor(b.y0));
    const w = Math.max(1, Math.ceil(b.x1 - b.x0)), hh = Math.max(1, Math.ceil(b.y1 - b.y0));
    let d;
    try { d = cx.getImageData(x, y, w, hh).data; } catch { return '#000000'; }
    const step = Math.max(1, Math.floor(d.length / 4 / 20000)) * 4;
    const px = [];
    for (let p = 0; p < d.length; p += step) px.push([d[p] * 0.3 + d[p + 1] * 0.59 + d[p + 2] * 0.11, p]);
    px.sort((a, c) => a[0] - c[0]);
    const dark = px.slice(0, Math.max(1, Math.round(px.length * 0.08)));
    const avg = [0, 1, 2].map((o) => Math.round(dark.reduce((t, [, p]) => t + d[p + o], 0) / dark.length));
    return '#' + avg.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  function placeBox(b) {
    const s = st.scale, r = b.box;
    Object.assign(b.style, { left: r.x * s + 'px', top: r.y * s + 'px', width: r.w * s + 'px', height: r.h * s + 'px' });
  }
  // Covers removed original text on screen. (Saving takes it out for real.)
  function drawMasks() {
    pageEls.forEach((p) => p.layer.querySelectorAll('.mask').forEach((m) => m.remove()));
    st.removed.forEach((color, key) => {
      const [i, j] = key.split(':').map(Number);
      st.texts[i]?.then((items) => {
        const r = items[j].box;
        const m = h('div', { class: 'mask', style: { background: color } });
        m.box = { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 };
        pageEls[i].layer.prepend(m);
        placeBox(m);
      });
    });
  }
  // The paper colour around a piece of text, so the cover blends in.
  function paperAround(i, r) {
    const c = pageEls[i].canvas;
    const k = c.width / sizes[i].w;
    const cx = c.getContext('2d', { willReadFrequently: true });
    const spots = [[r.x - 2, r.y + r.h / 2], [r.x + r.w + 2, r.y + r.h / 2], [r.x + r.w / 2, r.y - 2], [r.x + r.w / 2, r.y + r.h + 2]];
    const px = spots.map(([x, y]) => {
      try { return [...cx.getImageData(clamp(Math.round(x * k), 0, c.width - 1), clamp(Math.round(y * k), 0, c.height - 1), 1, 1).data]; } catch { return [255, 255, 255, 255]; }
    }).sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2]));
    const p = px[1]; // second lightest: ignores a neighbouring letter
    return '#' + p.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  // Turns a piece of the PDF's text into a normal text object.
  async function takeText(i, key) {
    const items = await readText(i);
    const it = items[+key.split(':')[1]];
    let color = it.color;
    if (it.hidden) { // invisible text has no colour of its own: take the scan's
      const c = pageEls[i].canvas, k = c.width / sizes[i].w, r = it.box;
      color = inkColor(c.getContext('2d', { willReadFrequently: true }), { x0: r.x * k, y0: r.y * k, x1: (r.x + r.w) * k, y1: (r.y + r.h) * k });
    }
    const o = add({ type: 'text', page: i, text: it.str.trim(), font: it.font, bold: it.bold, size: Math.round(it.size * 10) / 10, color, x: it.box.x, y: it.box.base - FONTS[it.font].base * it.size, orig: key });
    st.removed.set(key, paperAround(i, it.box));
    pageEls[i].layer.querySelector(`.tx[data-key="${key}"]`)?.remove();
    drawMasks();
    return o;
  }

  /* objects */
  const snapshot = () => { st.history.push({ objects: st.objects.map((o) => ({ ...o })), removed: new Map(st.removed) }); if (st.history.length > 60) st.history.shift(); };
  function undo() {
    const prev = st.history.pop();
    if (!prev) return;
    els.forEach((el) => el.remove());
    els.clear();
    st.objects = prev.objects;
    st.removed = prev.removed;
    st.objects.forEach((o) => { make(o); place(o); });
    drawMasks();
    st.texts.forEach((t, i) => t && showBoxes(i).catch(textFailed));
    select(null);
  }
  function add(o) {
    snapshot();
    o.id = uid();
    st.objects.push(o);
    make(o);
    place(o);
    return o;
  }
  function remove(o) {
    snapshot();
    st.objects = st.objects.filter((x) => x !== o);
    els.get(o.id)?.remove();
    els.delete(o.id);
    select(null);
  }
  function make(o) {
    let el;
    if (o.type === 'text') {
      el = h('div', { class: 'obj obj--text', spellcheck: 'false' });
      el.textContent = o.text;
      el.addEventListener('dblclick', () => editText(o));
      el.addEventListener('input', () => { o.text = el.innerText.replace(/\n$/, ''); measure(o); });
      el.addEventListener('blur', () => finishText(o));
    } else if (o.type === 'image') {
      el = h('div', { class: 'obj obj--img' }, h('img', { src: o.src, alt: '', draggable: 'false' }));
    } else if (o.type === 'rect') {
      el = h('div', { class: `obj obj--rect obj--${o.kind}` });
    } else if (o.type === 'path') {
      el = h('div', { class: 'obj obj--path' });
      el.innerHTML = '<svg preserveAspectRatio="none"><polyline fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    el.dataset.id = o.id;
    // Reachable by Tab: focus selects it, Enter edits text, arrows move it
    // and Delete removes it (see onKey).
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', o.type === 'text' ? `Text: ${o.text || 'empty'}` : o.kind === 'sig' ? 'Signature' : o.type === 'image' ? 'Image' : o.type === 'path' ? 'Drawing' : o.kind === 'highlight' ? 'Highlight' : 'White-out');
    el.addEventListener('focus', () => { if (st.selected !== o.id && st.editing !== o.id) select(o.id); });
    el.addEventListener('keydown', (e) => {
      if (st.editing === o.id || e.key !== 'Enter' || o.type !== 'text') return;
      e.preventDefault();
      editText(o);
    });
    el.append(h('span', { class: 'obj__h', 'data-h': 'se' }));
    pageEls[o.page].layer.append(el);
    els.set(o.id, el);
    restyle(o);
    return el;
  }
  function restyle(o) {
    const el = els.get(o.id);
    if (!el) return;
    if (o.type === 'text') {
      Object.assign(el.style, { fontFamily: FONTS[o.font].css, fontWeight: o.bold ? '700' : '400', color: o.color, textAlign: o.align || 'left' });
      measure(o);
    } else if (o.type === 'rect') el.style.background = o.color;
    else if (o.type === 'path') {
      const pl = el.querySelector('polyline');
      pl.setAttribute('stroke', o.color);
    }
    place(o);
  }
  function measure(o) {
    const el = els.get(o.id);
    el.style.fontSize = o.size * st.scale + 'px';
    o.w = el.offsetWidth / st.scale;
    o.h = el.offsetHeight / st.scale;
  }
  function place(o) {
    const el = els.get(o.id);
    if (!el) return;
    const s = st.scale;
    Object.assign(el.style, { left: o.x * s + 'px', top: o.y * s + 'px' });
    if (o.type === 'text') { el.style.fontSize = o.size * s + 'px'; el.style.lineHeight = String(LH); return; }
    Object.assign(el.style, { width: o.w * s + 'px', height: o.h * s + 'px' });
    if (o.type === 'path') {
      const svgEl = el.querySelector('svg');
      svgEl.setAttribute('viewBox', `0 0 ${Math.max(o.w * s, 1)} ${Math.max(o.h * s, 1)}`);
      const pl = svgEl.querySelector('polyline');
      pl.setAttribute('points', o.pts.map(([nx, ny]) => `${nx * o.w * s},${ny * o.h * s}`).join(' '));
      pl.setAttribute('stroke-width', o.width * s);
    }
  }
  function select(id) {
    if (st.editing && st.editing !== id) els.get(st.editing)?.blur();
    st.selected = id;
    els.forEach((el, k) => el.classList.toggle('sel', k === id));
    drawProps();
  }
  function editText(o) {
    const el = els.get(o.id);
    st.editing = o.id;
    select(o.id);
    st.editing = o.id;
    st.textBefore = o.text;
    el.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
  function finishText(o) {
    const el = els.get(o.id);
    if (!el) return;
    el.contentEditable = 'false';
    el.classList.remove('editing');
    if (st.editing === o.id) st.editing = null;
    o.text = el.innerText.replace(/\n$/, '');
    if (!o.text.trim()) { st.objects = st.objects.filter((x) => x !== o); el.remove(); els.delete(o.id); if (st.selected === o.id) select(null); return; }
    measure(o);
  }

  /* placing things (by pointer, or in the middle of the page for keyboards) */
  function placePending(page, p, focus = false) {
    const { src, kind } = st.pending;
    const { w: PW, h: PH } = sizes[page];
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalHeight / img.naturalWidth || 0.4;
      const w = Math.min(kind === 'sig' ? 160 : 220, PW * 0.6);
      const hh = w * ratio;
      const o = add({ type: 'image', page, src, kind, x: clamp(p.x - w / 2, 0, PW - w), y: clamp(p.y - hh / 2, 0, PH - hh), w, h: hh });
      st.pending = null;
      syncTools();
      select(o.id);
      if (focus) els.get(o.id)?.focus();
    };
    img.src = src;
  }
  function addTextAt(page, p) {
    const t = st.text;
    const date = st.tool === 'date';
    const o = add({ type: 'text', page, text: date ? new Date().toLocaleDateString() : '', font: t.font, size: t.size, color: t.color, bold: t.bold, align: t.align, x: p.x, y: p.y - (t.size * LH) / 2 });
    if (date) { measure(o); select(o.id); }
    else setTimeout(() => editText(o), 0);
    st.tool = 'select';
    syncTools();
    select(o.id);
    return o;
  }
  function placeCentre() {
    const page = st.curPage || 0;
    const p = { x: sizes[page].w / 2, y: sizes[page].h / 2 };
    if (st.pending) placePending(page, p, true);
    else if (st.tool === 'text' || st.tool === 'date') {
      const date = st.tool === 'date';
      const o = addTextAt(page, { x: p.x - 40, y: p.y });
      if (date) els.get(o.id)?.focus(); // new text gets the caret instead
    }
  }

  /* pointer handling on the pages */
  const pt =(layer, e) => { const r = layer.getBoundingClientRect(); return { x: (e.clientX - r.left) / st.scale, y: (e.clientY - r.top) / st.scale }; };

  pagesEl.addEventListener('pointerdown', (e) => {
    const layer = e.target.closest('.ed-layer');
    if (!layer || e.button > 0) return;
    const page = +layer.dataset.page;
    const { w: PW, h: PH } = sizes[page];
    const p = pt(layer, e);
    const objEl = e.target.closest('.obj');

    // Placing a signature or image.
    if (st.pending) {
      e.preventDefault();
      placePending(page, p);
      return;
    }

    // Grabbing the PDF's own text: it becomes a text object, then the same
    // gesture moves it (drag) or starts typing (click).
    const txEl = st.tool === 'edittext' && !objEl && e.target.closest('.tx');
    if (txEl) {
      e.preventDefault();
      let up = null, last = null;
      // The conversion is async; remember the pointer meanwhile.
      const early = (ev) => (last = ev);
      const earlyUp = (ev) => (up = ev);
      window.addEventListener('pointermove', early);
      window.addEventListener('pointerup', earlyUp, { once: true });
      takeText(page, txEl.dataset.key).then((o) => {
        window.removeEventListener('pointermove', early);
        window.removeEventListener('pointerup', earlyUp);
        select(o.id);
        const start = { ...o };
        let moved = false;
        const move = (ev) => {
          const q = pt(layer, ev);
          const dx = q.x - p.x, dy = q.y - p.y;
          if (!moved && Math.hypot(dx, dy) * st.scale < 3) return;
          moved = true;
          o.x = start.x + dx; o.y = start.y + dy; place(o);
        };
        if (last) move(last);
        if (up) { if (!moved) editText(o); return; }
        drag(e, move, () => { if (!moved) editText(o); });
      });
      return;
    }

    // Moving or resizing an existing object.
    const hit = objEl && st.objects.find((x) => x.id === objEl.dataset.id);
    // In Text mode only existing text is grabbed; clicking white-out or an
    // image starts new text on top of it.
    if (hit && (st.tool === 'select' || hit.type === 'text') && ['select', 'text', 'date', 'edittext'].includes(st.tool)) {
      const o = hit;
      if (st.editing === o.id) return; // typing: let the caret move
      e.preventDefault();
      const wasSelected = st.selected === o.id;
      select(o.id);
      const resize = !!e.target.closest('.obj__h');
      const start = { ...o };
      let moved = false;
      drag(e, (ev) => {
        const q = pt(layer, ev);
        const dx = q.x - p.x, dy = q.y - p.y;
        if (!moved) { if (Math.hypot(dx, dy) * st.scale < 3) return; snapshot(); moved = true; }
        if (!resize) { o.x = clamp(start.x + dx, -o.w / 2, PW - o.w / 2); o.y = clamp(start.y + dy, -o.h / 2, PH - o.h / 2); place(o); return; }
        if (o.type === 'text') { o.size = clamp(start.size * (start.h + dy) / start.h, 6, 200); measure(o); place(o); drawProps(); return; }
        let w = Math.max(8, start.w + dx), hh = Math.max(6, start.h + dy);
        if (o.type === 'image') hh = w * (start.h / start.w);
        o.w = w; o.h = hh; place(o);
      }, () => { if (!moved && o.type === 'text' && wasSelected) editText(o); });
      return;
    }

    if (st.tool === 'select' || st.tool === 'edittext') { select(null); return; }

    if (st.tool === 'text' || st.tool === 'date') {
      e.preventDefault();
      addTextAt(page, p);
      return;
    }

    if (st.tool === 'draw') {
      e.preventDefault();
      const pts = [[p.x, p.y]];
      const ghost = h('div', { class: 'obj obj--path live' });
      ghost.innerHTML = `<svg style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"><polyline fill="none" stroke="${st.pen.color}" stroke-width="${st.pen.width * st.scale}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      Object.assign(ghost.style, { left: 0, top: 0, width: '100%', height: '100%' });
      layer.append(ghost);
      const pl = ghost.querySelector('polyline');
      drag(e, (ev) => {
        const q = pt(layer, ev);
        pts.push([clamp(q.x, 0, PW), clamp(q.y, 0, PH)]);
        pl.setAttribute('points', pts.map(([x, y]) => `${x * st.scale},${y * st.scale}`).join(' '));
      }, () => {
        ghost.remove();
        if (pts.length < 2) pts.push([p.x + 0.5, p.y + 0.5]);
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        const w = Math.max(Math.max(...xs) - x, 0.5), hh = Math.max(Math.max(...ys) - y, 0.5);
        add({ type: 'path', page, x, y, w, h: hh, color: st.pen.color, width: st.pen.width, pts: pts.map(([px, py]) => [(px - x) / w, (py - y) / hh]) });
      });
      return;
    }

    if (st.tool === 'highlight' || st.tool === 'whiteout') {
      e.preventDefault();
      const kind = st.tool;
      const box = h('div', { class: `obj obj--rect obj--${kind} live`, style: { background: (kind === 'highlight' ? st.mark : st.white).color } });
      layer.append(box);
      let r = { x: p.x, y: p.y, w: 0, h: 0 };
      drag(e, (ev) => {
        const q = pt(layer, ev);
        const x2 = clamp(q.x, 0, PW), y2 = clamp(q.y, 0, PH);
        r = { x: Math.min(p.x, x2), y: Math.min(p.y, y2), w: Math.abs(x2 - p.x), h: Math.abs(y2 - p.y) };
        Object.assign(box.style, { left: r.x * st.scale + 'px', top: r.y * st.scale + 'px', width: r.w * st.scale + 'px', height: r.h * st.scale + 'px' });
      }, () => {
        box.remove();
        if (r.w < 3 || r.h < 3) { // a click: make a sensible default box
          r = kind === 'highlight' ? { x: p.x - 60, y: p.y - 8, w: 120, h: 16 } : { x: p.x - 50, y: p.y - 10, w: 100, h: 20 };
        }
        add({ type: 'rect', page, kind, color: (kind === 'highlight' ? st.mark : st.white).color, ...r });
      });
    }
  });

  document.addEventListener('keydown', onKey);
  function onKey(e) {
    if (gone()) return;
    // Keys pressed in a dialog (signature, password…) are the dialog's.
    if (document.querySelector('.modal') || e.target.closest?.('.modal')) return;
    if (st.editing || e.target.closest?.('input, select, textarea, [contenteditable="plaintext-only"], [contenteditable="true"]')) return;
    const sel = st.selected && st.objects.find((o) => o.id === st.selected);
    const onPage = e.target === document.body || pagesEl.contains(e.target);
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); remove(sel); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') { st.pending = null; st.tool = 'select'; select(null); syncTools(); }
    else if (sel && onPage && e.key.startsWith('Arrow')) {
      // Nudge: one undo step per burst of key presses.
      e.preventDefault();
      if (st.nudged !== sel.id || Date.now() - st.nudgedAt > 1000) snapshot();
      st.nudged = sel.id; st.nudgedAt = Date.now();
      const d = e.shiftKey ? 10 : 1, { w: PW, h: PH } = sizes[sel.page];
      if (e.key === 'ArrowLeft') sel.x -= d; else if (e.key === 'ArrowRight') sel.x += d;
      else if (e.key === 'ArrowUp') sel.y -= d; else if (e.key === 'ArrowDown') sel.y += d;
      sel.x = clamp(sel.x, -(sel.w || 0) / 2, PW - (sel.w || 0) / 2);
      sel.y = clamp(sel.y, -(sel.h || 0) / 2, PH - (sel.h || 0) / 2);
      place(sel);
    }
  }

  fitWidth();
  syncTools();
  if (signMode) setTimeout(() => (loadSigs().length ? toast('Pick your signature on the right, then click on the page.') : newSignature()), 300);
}

function drag(e, onMove, onUp) {
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onUp?.(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
const clamp = (v, a, b) => Math.min(Math.max(v, a), Math.max(a, b));

/* ---------- saving ---------- */

async function saveEditor(ctx) {
  const st = ctx.state;
  if (st.editing) document.activeElement?.blur();
  await tick();
  if (!st.objects.length && !st.removed.size) throw new Error('Change something on the pages first.');
  const lib = await loadLib(st.doc);
  const fonts = {};
  const font = async (name, bold) => {
    const key = FONTS[name].std[bold ? 1 : 0];
    return (fonts[key] ||= await lib.embedFont(StandardFonts[key]));
  };

  // Original text that was changed, moved or deleted: take its drawing
  // commands out of the page. A command can carry neighbouring text too;
  // plan() finds that text, and it is drawn again where it was.
  const byPage = new Map();
  st.removed.forEach((color, key) => {
    const [i, j] = key.split(':').map(Number);
    if (!byPage.has(i)) byPage.set(i, new Map());
    byPage.get(i).set(j, color);
  });
  for (const [i, colors] of byPage) {
    const items = await st.texts[i];
    const read = readPage(lib, i);
    const { drop, redraw, cover } = plan(items, new Set(colors.keys()));
    if (drop.size) dropOps(lib, read, drop);
    const page = read.page;
    // Invisible text (OCR over a scan) went with its commands, but the words
    // are still in the picture underneath.
    for (const j of colors.keys()) if (items[j].hidden && !cover.includes(j)) cover.push(j);
    for (const j of cover) { // text we couldn't find the command for (e.g. inside a form)
      const it = items[j];
      if (it.ocr) { // words read from a scan here: the box is in view points
        const f = pageFrame(page), kx = f.W / st.sizes[i].w, ky = f.H / st.sizes[i].h;
        const W = (it.box.w + 2) * kx, H = (it.box.h + 2) * ky;
        const a = boxAnchor(f, (it.box.x - 1) * kx + W / 2, (it.box.y - 1) * ky + H / 2, W, H);
        page.drawRectangle({ x: a.x, y: a.y, width: W, height: H, rotate: a.rotate, color: hexToRgb(colors.get(j)) });
        continue;
      }
      const t = it.transform, s = Math.hypot(t[2], t[3]), len = Math.hypot(t[0], t[1]) || 1;
      const ux = -t[1] / len, uy = t[0] / len; // "up" for this text
      // Words in a scan sit less exactly on the OCR layer's baseline: cover more.
      const below = it.hidden ? 0.4 : 0.25, tall = it.hidden ? 1.45 : 1.2, side = it.hidden ? 0.1 * s : 0;
      page.drawRectangle({ x: t[4] - ux * below * s - uy * side, y: t[5] - uy * below * s + ux * side, width: Math.max(it.width, s * 0.3) + 2 * side, height: s * tall, rotate: degrees((Math.atan2(t[1], t[0]) * 180) / Math.PI), color: hexToRgb(colors.get(j)) });
    }
    for (const j of redraw) {
      const it = items[j];
      if (!it.str || it.hidden) continue; // drawing invisible text again would make it show
      const t = it.transform, s = Math.hypot(t[2], t[3]);
      const rotate = degrees((Math.atan2(t[1], t[0]) * 180) / Math.PI);
      const fnt = await font(it.font, it.bold);
      if (fontCanDraw(fnt, it.str)) page.drawText(it.str, { x: t[4], y: t[5], size: s, font: fnt, color: hexToRgb(it.color), rotate });
      else {
        const png = await textAsPng(it.str, { family: FONTS[it.font].css, bold: it.bold, size: s, color: it.color, lineHeight: LH });
        page.drawImage(await lib.embedPng(png.bytes), { x: t[4], y: t[5] - s * 0.3, width: png.width, height: png.height, rotate });
      }
    }
  }
  const images = new Map();
  const embedSrc = async (src) => {
    if (images.has(src)) return images.get(src);
    let im = st.images?.get(src);
    if (!im) { // signatures are PNG data URLs
      const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
      im = { bytes, png: true };
    }
    const emb = im.png ? await lib.embedPng(im.bytes) : await lib.embedJpg(im.bytes);
    images.set(src, emb);
    return emb;
  };

  // Draw in creation order so later things sit on top.
  for (const o of st.objects) {
    const page = lib.getPage(o.page);
    const f = pageFrame(page);
    // pdf.js and pdf-lib can disagree slightly on page size; scale to match.
    const kx = f.W / st.sizes[o.page].w, ky = f.H / st.sizes[o.page].h;
    const X = o.x * kx, Y = o.y * ky, W = o.w * kx, H = o.h * ky;
    const rot = degrees(f.R);
    if (o.type === 'image') {
      const a = boxAnchor(f, X + W / 2, Y + H / 2, W, H);
      page.drawImage(await embedSrc(o.src), { x: a.x, y: a.y, width: W, height: H, rotate: a.rotate });
    } else if (o.type === 'rect') {
      const a = boxAnchor(f, X + W / 2, Y + H / 2, W, H);
      const hl = o.kind === 'highlight';
      page.drawRectangle({ x: a.x, y: a.y, width: W, height: H, rotate: a.rotate, color: hexToRgb(o.color), opacity: hl ? 0.45 : 1, blendMode: hl ? BlendMode.Multiply : undefined });
    } else if (o.type === 'path') {
      const pts = o.pts.map(([nx, ny]) => f.map(X + nx * W, Y + ny * H));
      const d = pts.map((q, k) => `${k ? 'L' : 'M'}${q.x.toFixed(2)} ${(-q.y).toFixed(2)}`).join(' ');
      page.drawSvgPath(d, { x: 0, y: 0, borderColor: hexToRgb(o.color), borderWidth: o.width, borderLineCap: 1 });
    } else if (o.type === 'text') {
      const fnt = await font(o.font, o.bold);
      const lines = o.text.split('\n');
      if (lines.every((l) => fontCanDraw(fnt, l))) {
        const widths = lines.map((l) => fnt.widthOfTextAtSize(l, o.size));
        const box = Math.max(...widths);
        lines.forEach((line, i) => {
          if (!line) return;
          const dx = o.align === 'center' ? (box - widths[i]) / 2 : o.align === 'right' ? box - widths[i] : 0;
          const q = f.map(X + dx, Y + (i * LH + FONTS[o.font].base) * o.size);
          page.drawText(line, { x: q.x, y: q.y, size: o.size, font: fnt, color: hexToRgb(o.color), rotate: rot });
        });
      } else {
        const png = await textAsPng(o.text, { family: FONTS[o.font].css, bold: o.bold, size: o.size, color: o.color, lineHeight: LH, align: o.align });
        const emb = await lib.embedPng(png.bytes);
        const a = boxAnchor(f, X + png.width / 2, Y + png.height / 2, png.width, png.height);
        page.drawImage(emb, { x: a.x, y: a.y, width: png.width, height: png.height, rotate: a.rotate });
      }
    }
  }
  busy('Saving…');
  const signed = ctx.items[0] && st.objects.some((o) => o.kind === 'sig');
  return {
    files: [{ name: `${baseName(st.doc.name)}-${signed ? 'signed' : 'edited'}.pdf`, bytes: await lib.save(), type: 'application/pdf' }],
    title: signed ? 'Your PDF is signed' : 'Your PDF is saved',
  };
}

/* ---------- signature maker ---------- */

const SIG_FONTS = ['Dancing Script', 'Great Vibes', 'Caveat', 'Sacramento'];
let fontsLinked = false;
function linkSigFonts() {
  if (fontsLinked) return;
  fontsLinked = true;
  document.head.append(h('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Dancing+Script:wght@600&family=Great+Vibes&family=Sacramento&display=swap' }));
}

function signatureDialog() {
  linkSigFonts();
  return modal({
    title: 'Create your signature',
    wide: true,
    okText: 'Use signature',
    body: (m) => {
      let tab = 'draw';
      let color = '#111111';
      const panes = {};

      // Draw
      const pad = h('canvas', { class: 'sigpad' });
      const ctx2 = pad.getContext('2d');
      let drawn = false;
      const sizePad = () => {
        const r = pad.getBoundingClientRect();
        if (!r.width) return;
        const img = drawn ? ctx2.getImageData(0, 0, pad.width, pad.height) : null;
        pad.width = r.width * 2; pad.height = r.height * 2;
        if (img) ctx2.putImageData(img, 0, 0);
      };
      setTimeout(sizePad, 30);
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (pad.width < 10) sizePad();
        const r = pad.getBoundingClientRect();
        const P = (ev) => [(ev.clientX - r.left) * 2, (ev.clientY - r.top) * 2];
        let last = P(e);
        let mid = last;
        ctx2.strokeStyle = color; ctx2.lineWidth = 5; ctx2.lineCap = ctx2.lineJoin = 'round';
        ctx2.beginPath(); ctx2.arc(last[0], last[1], 2.5, 0, 7); ctx2.fillStyle = color; ctx2.fill();
        drawn = true;
        drag(e, (ev) => {
          const q = P(ev);
          const nm = [(last[0] + q[0]) / 2, (last[1] + q[1]) / 2];
          ctx2.beginPath(); ctx2.moveTo(mid[0], mid[1]); ctx2.quadraticCurveTo(last[0], last[1], nm[0], nm[1]); ctx2.stroke();
          last = q; mid = nm;
        });
      });
      panes.draw = h('div', {}, pad, h('div', { class: 'row-between' }, h('span', { class: 'muted small' }, 'Sign with your mouse, finger or pen.'), h('button', { class: 'linkbtn', onclick: () => { ctx2.clearRect(0, 0, pad.width, pad.height); drawn = false; } }, 'Clear')));

      // Type
      let typed = '';
      let face = SIG_FONTS[0];
      const samples = h('div', { class: 'sigfonts' });
      const drawSamples = () => samples.replaceChildren(...SIG_FONTS.map((fname) => h('button', {
        class: 'sigfont' + (fname === face ? ' on' : ''), style: { fontFamily: `"${fname}", cursive`, color },
        onclick: () => { face = fname; drawSamples(); },
      }, typed || 'Your name')));
      const nameIn = h('input', { class: 'field', placeholder: 'Type your name', oninput: (e) => { typed = e.target.value; drawSamples(); } });
      panes.type = h('div', { hidden: true }, nameIn, samples);
      drawSamples();

      // Upload
      let upload = null;
      let clean = true;
      const prev = h('div', { class: 'sigprev' }, h('span', { class: 'muted small' }, 'A photo or scan of your signature on white paper.'));
      const showUpload = async () => {
        if (!upload) return;
        const c = await imageToCanvas(upload, 1200);
        if (clean) knockOutWhite(c);
        prev.replaceChildren(c);
        prev.canvas = c;
      };
      panes.upload = h('div', { hidden: true },
        h('button', { class: 'btn btn--ghost', onclick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { upload = f; showUpload(); } } }, icon('upload'), 'Choose image'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { clean = e.target.checked; showUpload(); } }), h('span', {}, 'Remove white background')),
        prev);

      const colors = h('div', { class: 'inkrow' }, ['#111111', '#1d4ed8', '#b91c1c'].map((c) => h('button', {
        class: 'ink' + (c === color ? ' on' : ''), style: { background: c }, 'aria-label': 'Ink colour',
        onclick: (e) => { color = c; colors.querySelectorAll('.ink').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); drawSamples(); },
      })));

      const tabs = h('div', { class: 'seg' }, [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']].map(([id, label]) => h('button', {
        type: 'button', class: id === tab ? 'on' : '',
        onclick: (e) => { tab = id; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); Object.entries(panes).forEach(([k, p]) => (p.hidden = k !== id)); colors.hidden = id === 'upload'; if (id === 'draw') setTimeout(sizePad, 0); },
      }, label)));

      // Nothing to use yet: say so and keep the dialog open.
      const hint = h('p', { class: 'sig-hint', role: 'alert', hidden: true });
      const nothing = (msg) => { hint.textContent = msg; hint.hidden = false; return STAY; };
      m.value = async () => {
        let c;
        if (tab === 'draw') { if (!drawn) return nothing('Sign in the box first.'); c = pad; }
        else if (tab === 'type') {
          if (!typed.trim()) return nothing('Type your name first.');
          await document.fonts.load(`120px "${face}"`);
          c = document.createElement('canvas');
          const x = c.getContext('2d');
          x.font = `120px "${face}", cursive`;
          c.width = Math.ceil(x.measureText(typed).width + 80); c.height = 220;
          x.font = `120px "${face}", cursive`; x.fillStyle = color; x.textBaseline = 'middle';
          x.fillText(typed, 40, 115);
        } else { if (!prev.canvas) return nothing('Choose an image of your signature first.'); c = prev.canvas; }
        return trimCanvas(c)?.toDataURL('image/png') || nothing('That image is blank. Try another one, or untick “Remove white background”.');
      };
      return [tabs, colors, panes.draw, panes.type, panes.upload, hint];
    },
  }).then((v) => v);
}

async function imageToCanvas(file, maxSide) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

// Paper turns transparent, ink stays: lightness above ~80% fades out.
function knockOutWhite(c) {
  const x = c.getContext('2d');
  const img = x.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11);
    if (l > 200) d[i + 3] = 0;
    else if (l > 150) d[i + 3] = Math.round(d[i + 3] * (200 - l) / 50);
  }
  x.putImageData(img, 0, 0);
}

// Crops to the inked area, with a little breathing room.
function trimCanvas(c) {
  const x = c.getContext('2d');
  const { data, width, height } = x.getImageData(0, 0, c.width, c.height);
  let t = height, l = width, r = -1, b = -1;
  for (let y = 0; y < height; y++) for (let xx = 0; xx < width; xx++) {
    if (data[(y * width + xx) * 4 + 3] > 8) { if (y < t) t = y; if (y > b) b = y; if (xx < l) l = xx; if (xx > r) r = xx; }
  }
  if (r < 0) return null;
  const pad = 6;
  l = Math.max(0, l - pad); t = Math.max(0, t - pad); r = Math.min(width - 1, r + pad); b = Math.min(height - 1, b + pad);
  const out = document.createElement('canvas');
  out.width = r - l + 1; out.height = b - t + 1;
  out.getContext('2d').drawImage(c, l, t, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
