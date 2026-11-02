// Edit PDF and Sign PDF: put text, signatures, images, pen strokes,
// highlights and white-out boxes on the pages, then write them into the file.
//
// Everything is kept in "view points": PDF points measured from the top-left
// of the page as it is shown (after its /Rotate). pageFrame() turns those into
// real PDF coordinates when saving.
import {
  h, icon, busy, tick, StandardFonts, degrees, BlendMode, loadLib, renderPage, baseName, pageSizes,
  pageFrame, boxAnchor, fontCanDraw, textAsPng, hexToRgb, imageForPdf, pickFiles, modal, uid, toast,
} from './core.js';

const FONTS = {
  Helvetica: { css: 'Helvetica, Arial, sans-serif', std: ['Helvetica', 'HelveticaBold'], base: 0.947 },
  Times: { css: '"Times New Roman", Times, serif', std: ['TimesRoman', 'TimesRomanBold'], base: 0.938 },
  Courier: { css: '"Courier New", Courier, monospace', std: ['Courier', 'CourierBold'], base: 0.867 },
};
const LH = 1.2; // text line height, in em
const SIG_KEY = 'pdftools.signatures';

const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } };
const saveSigs = (list) => { try { localStorage.setItem(SIG_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* private mode */ } };

export function editorTool(mode) {
  const sign = mode === 'sign';
  return {
    id: mode, cat: 'edit', wide: true, editor: true,
    title: sign ? 'Sign PDF' : 'Edit PDF',
    icon: sign ? 'sign' : 'edit',
    color: sign ? '#f472b6' : '#fb7185',
    action: sign ? 'Sign and save' : 'Save PDF',
    busyText: 'Saving…',
    desc: sign ? 'Draw, type or upload your signature and place it on the page.' : 'Add text, images, drawings, highlights and white-out to a PDF.',
    long: sign
      ? 'Make your signature once, then click on the page to place it. Add the date or your name the same way.'
      : 'Add text, images, your signature, pen drawings and highlights. Cover existing text with white-out and type over it.',
    setup: (ctx) => setupEditor(ctx, sign),
    run: (ctx) => saveEditor(ctx),
  };
}

/* ---------- setup ---------- */

async function setupEditor(ctx, signMode) {
  const doc = ctx.items[0];
  const sizes = await pageSizes(doc.js);
  const st = ctx.state = {
    doc, sizes, objects: [], history: [], tool: 'select', selected: null, editing: null, pending: null, scale: 1,
    text: { font: 'Helvetica', size: 14, color: '#111111', bold: false },
    pen: { color: '#1d4ed8', width: 2 },
    mark: { color: '#fde047' },
    white: { color: '#ffffff' },
  };
  const els = new Map(); // object id -> element

  /* toolbar */
  const tools = signMode
    ? [['select', 'cursor', 'Select'], ['sign', 'sign', 'Signature'], ['text', 'text', 'Text'], ['date', 'numbers', 'Date'], ['image', 'image', 'Image']]
    : [['select', 'cursor', 'Select'], ['text', 'text', 'Text'], ['sign', 'sign', 'Signature'], ['image', 'image', 'Image'], ['draw', 'pen', 'Draw'], ['highlight', 'highlight', 'Highlight'], ['whiteout', 'whiteout', 'White-out']];
  const bar = h('div', { class: 'ed-bar', role: 'toolbar', 'aria-label': 'Editing tools' });
  const toolBtns = tools.map(([id, ic, label]) => {
    const b = h('button', { class: 'ed-tool', 'data-tool': id, title: label, onclick: () => pickTool(id) }, icon(ic), h('span', {}, label));
    return b;
  });
  const zoomOut = h('button', { class: 'iconbtn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoom(1 / 1.2) }, '−');
  const zoomIn = h('button', { class: 'iconbtn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoom(1.2) }, '+');
  const undoBtn = h('button', { class: 'iconbtn', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => undo() }, icon('undo'));
  bar.append(h('div', { class: 'ed-tools' }, toolBtns), h('div', { class: 'ed-zoom' }, undoBtn, zoomOut, zoomIn));

  /* pages */
  const pagesEl = h('div', { class: 'ed-pages' });
  const pageEls = sizes.map((sz, i) => {
    const canvas = h('canvas');
    const layer = h('div', { class: 'ed-layer', 'data-page': i });
    const wrap = h('div', { class: 'ed-page', 'data-page': i }, canvas, layer, h('span', { class: 'ed-pnum' }, `${i + 1} / ${sizes.length}`));
    wrap.canvas = canvas; wrap.layer = layer; wrap.rendered = 0;
    pagesEl.append(wrap);
    return wrap;
  });
  ctx.main.append(bar, pagesEl);
  ctx.main.classList.add('ed-main');

  // Draw pages only when they scroll into view.
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) paintPage(+en.target.dataset.page);
  }), { rootMargin: '600px 0px' });
  pageEls.forEach((p) => io.observe(p));

  async function paintPage(i) {
    const p = pageEls[i];
    if (p.rendered === st.scale) return;
    p.rendered = st.scale;
    await renderPage(doc.js, i, sizes[i].w * st.scale, { canvas: p.canvas }).catch(() => {});
  }

  function layout() {
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
  new ResizeObserver(() => { if (!st.userZoom) fitWidth(); }).observe(pagesEl);
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
    props,
    !signMode && h('p', { class: 'muted small' }, 'Tip: to change existing text, cover it with White-out and type the new text on top.'));

  function drawSigs() {
    const list = loadSigs();
    sigList.replaceChildren(...list.map((src, k) => h('div', { class: 'sig' + (st.pending?.src === src ? ' on' : '') },
      h('button', { class: 'sig__use', title: 'Place this signature', onclick: () => armImage(src, 'sig') }, h('img', { src, alt: 'Signature' })),
      h('button', { class: 'iconbtn sig__x', 'aria-label': 'Forget this signature', onclick: () => { const l = loadSigs(); l.splice(k, 1); saveSigs(l); drawSigs(); } }, icon('x')))));
    if (!list.length) sigList.append(h('p', { class: 'muted small' }, 'No signature yet.'));
  }
  if (signMode) drawSigs();

  function drawProps() {
    const o = st.selected && st.objects.find((x) => x.id === st.selected);
    const type = o?.type || ({ text: 'text', date: 'text', draw: 'path', highlight: 'rect', whiteout: 'rect' })[st.tool];
    const kids = [];
    if (type === 'text') {
      const t = o || st.text;
      const set = (k, v) => { if (o) { snapshot(); o[k] = v; restyle(o); } st.text[k] = v; };
      kids.push(
        h('p', { class: 'f__label' }, 'Text'),
        h('div', { class: 'row2' },
          h('select', { class: 'field', 'aria-label': 'Font', onchange: (e) => set('font', e.target.value) }, Object.keys(FONTS).map((f) => h('option', { selected: f === t.font }, f))),
          h('input', { class: 'field', type: 'number', min: 6, max: 144, value: t.size, 'aria-label': 'Size', onchange: (e) => set('size', Math.min(144, Math.max(6, +e.target.value || 14))) })),
        h('div', { class: 'row2' },
          h('input', { type: 'color', class: 'swatch', value: t.color, 'aria-label': 'Colour', oninput: (e) => set('color', e.target.value) }),
          h('button', { class: 'btn btn--ghost' + (t.bold ? ' on' : ''), onclick: (e) => { set('bold', !t.bold); e.currentTarget.classList.toggle('on'); } }, h('b', {}, 'B'), ' Bold')));
    } else if (type === 'path') {
      const t = o || st.pen;
      kids.push(h('p', { class: 'f__label' }, 'Pen'),
        h('div', { class: 'row2' },
          h('input', { type: 'color', class: 'swatch', value: t.color, 'aria-label': 'Colour', oninput: (e) => { st.pen.color = e.target.value; if (o) { o.color = e.target.value; restyle(o); } } }),
          h('select', { class: 'field', 'aria-label': 'Thickness', onchange: (e) => { st.pen.width = +e.target.value; if (o) { o.width = +e.target.value; restyle(o); } } },
            [[1, 'Thin'], [2, 'Normal'], [4, 'Thick'], [8, 'Marker']].map(([v, l]) => h('option', { value: v, selected: v === t.width }, l)))));
    } else if (type === 'rect') {
      const which = o ? o.kind : st.tool;
      const t = o || (which === 'highlight' ? st.mark : st.white);
      kids.push(h('p', { class: 'f__label' }, which === 'highlight' ? 'Highlight' : 'White-out'),
        h('input', { type: 'color', class: 'swatch', value: t.color, 'aria-label': 'Colour', oninput: (e) => { (which === 'highlight' ? st.mark : st.white).color = e.target.value; if (o) { o.color = e.target.value; restyle(o); } } }),
        !o && h('p', { class: 'muted small' }, 'Drag across the page to draw the box.'));
    }
    if (o) kids.push(h('button', { class: 'btn btn--ghost btn--block danger', onclick: () => remove(o) }, icon('trash'), 'Delete'));
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

  /* objects */
  const snapshot = () => { st.history.push(st.objects.map((o) => ({ ...o }))); if (st.history.length > 60) st.history.shift(); };
  function undo() {
    const prev = st.history.pop();
    if (!prev) return;
    els.forEach((el) => el.remove());
    els.clear();
    st.objects = prev;
    st.objects.forEach((o) => { make(o); place(o); });
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
      Object.assign(el.style, { fontFamily: FONTS[o.font].css, fontWeight: o.bold ? '700' : '400', color: o.color });
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

  /* pointer handling on the pages */
  const pt = (layer, e) => { const r = layer.getBoundingClientRect(); return { x: (e.clientX - r.left) / st.scale, y: (e.clientY - r.top) / st.scale }; };

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
      const { src, kind } = st.pending;
      const img = new Image();
      img.onload = () => {
        const ratio = img.naturalHeight / img.naturalWidth || 0.4;
        const w = Math.min(kind === 'sig' ? 160 : 220, PW * 0.6);
        const hh = w * ratio;
        const o = add({ type: 'image', page, src, kind, x: clamp(p.x - w / 2, 0, PW - w), y: clamp(p.y - hh / 2, 0, PH - hh), w, h: hh });
        st.pending = null;
        syncTools();
        select(o.id);
      };
      img.src = src;
      return;
    }

    // Moving or resizing an existing object.
    const hit = objEl && st.objects.find((x) => x.id === objEl.dataset.id);
    // In Text mode only existing text is grabbed; clicking white-out or an
    // image starts new text on top of it.
    if (hit && (st.tool === 'select' || hit.type === 'text') && ['select', 'text', 'date'].includes(st.tool)) {
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

    if (st.tool === 'select') { select(null); return; }

    if (st.tool === 'text' || st.tool === 'date') {
      e.preventDefault();
      const t = st.text;
      const text = st.tool === 'date' ? new Date().toLocaleDateString() : '';
      const o = add({ type: 'text', page, text, font: t.font, size: t.size, color: t.color, bold: t.bold, x: p.x, y: p.y - (t.size * LH) / 2 });
      if (st.tool === 'date') { measure(o); select(o.id); }
      else setTimeout(() => editText(o), 0);
      st.tool = 'select';
      syncTools();
      select(o.id);
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
    if (!document.body.contains(pagesEl)) { document.removeEventListener('keydown', onKey); return; }
    if (st.editing || e.target.closest?.('input, select, textarea')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.selected) { e.preventDefault(); remove(st.objects.find((o) => o.id === st.selected)); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') { st.pending = null; st.tool = 'select'; select(null); syncTools(); }
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
  if (!st.objects.length) throw new Error('Add something to the pages first.');
  const lib = await loadLib(st.doc);
  const fonts = {};
  const font = async (name, bold) => {
    const key = FONTS[name].std[bold ? 1 : 0];
    return (fonts[key] ||= await lib.embedFont(StandardFonts[key]));
  };
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
        lines.forEach((line, i) => {
          if (!line) return;
          const q = f.map(X, Y + (i * LH + FONTS[o.font].base) * o.size);
          page.drawText(line, { x: q.x, y: q.y, size: o.size, font: fnt, color: hexToRgb(o.color), rotate: rot });
        });
      } else {
        const png = await textAsPng(o.text, { family: FONTS[o.font].css, bold: o.bold, size: o.size, color: o.color, lineHeight: LH });
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

      m.value = async () => {
        let c;
        if (tab === 'draw') { if (!drawn) return null; c = pad; }
        else if (tab === 'type') {
          if (!typed.trim()) return null;
          await document.fonts.load(`120px "${face}"`);
          c = document.createElement('canvas');
          const x = c.getContext('2d');
          x.font = `120px "${face}", cursive`;
          c.width = Math.ceil(x.measureText(typed).width + 80); c.height = 220;
          x.font = `120px "${face}", cursive`; x.fillStyle = color; x.textBaseline = 'middle';
          x.fillText(typed, 40, 115);
        } else { if (!prev.canvas) return null; c = prev.canvas; }
        return trimCanvas(c)?.toDataURL('image/png') || null;
      };
      return [tabs, colors, panes.draw, panes.type, panes.upload];
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
