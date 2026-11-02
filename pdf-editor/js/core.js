// Shared plumbing for every tool: reading files, passwords, rendering pages,
// downloads, the busy overlay and small DOM helpers.

export const { PDFDocument, StandardFonts, rgb, degrees, BlendMode } = window.PDFLib;
const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js', import.meta.url).href;

/* ---------- DOM ---------- */

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.innerHTML = ICONS[name] || '';
  return span;
}

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  merge: svg('<path d="M8 3v5a4 4 0 0 0 4 4 4 4 0 0 1 4 4v5"/><path d="M16 3v5a4 4 0 0 1-4 4"/><path d="m5 18 3 3 3-3"/>'),
  split: svg('<path d="M12 3v6"/><path d="M12 9 6 15v6"/><path d="m12 9 6 6v6"/><path d="m3 18 3 3 3-3"/><path d="m15 18 3 3 3-3"/>'),
  organize: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="9" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/>'),
  rotate: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  rotateLeft: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  compress: svg('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>'),
  jpgToPdf: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'),
  pdfToJpg: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="m8 17 3-3 2 2 3-3"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  sign: svg('<path d="M3 17c3-1 4-9 7-9s-1 9 2 9 3-4 5-4 1 3 4 3"/><path d="M3 21h18"/>'),
  watermark: svg('<path d="M12 2.7c3 4 6 7.3 6 11.3a6 6 0 0 1-12 0c0-4 3-7.3 6-11.3Z"/>'),
  numbers: svg('<path d="M4 6h2v6"/><path d="M4 12h4"/><path d="M13 7h5l-4 5a3 3 0 1 1-2 4"/>'),
  protect: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  unlock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.3"/>'),
  upload: svg('<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/>'),
  download: svg('<path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M4 20h16"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>'),
  back: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  grip: svg('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>'),
  text: svg('<path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M9 20h6"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'),
  pen: svg('<path d="M3 21c4-1 6-4 9-8l5-5a2 2 0 0 0-3-3l-5 5c-4 3-7 5-8 9"/>'),
  highlight: svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
  whiteout: svg('<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 12h10" stroke-dasharray="2 2"/>'),
  cursor: svg('<path d="m4 4 7 17 2.5-7.5L21 11Z"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>'),
};

/* ---------- busy overlay + toast ---------- */

const busyEl = () => document.getElementById('busy');
export function busy(text) {
  const el = busyEl();
  if (text === false) { el.hidden = true; return; }
  document.getElementById('busy-text').textContent = text || 'Working…';
  el.hidden = false;
}
let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}
// Lets the overlay paint before a long synchronous step.
export const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------- files ---------- */

export const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
export const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name);

export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1) + ' MB';
}
export const baseName = (name) => name.replace(/\.[^.]+$/, '');

export function pickFiles({ accept = 'application/pdf,.pdf', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function download(bytes, name, type = 'application/pdf') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* ---------- opening PDFs (with password prompt) ---------- */

// A loaded PDF: original bytes, the password that opened it (if any),
// a pdf.js document for drawing pages, and its page count.
export async function openPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password;
  let js;
  for (let attempt = 0; ; attempt++) {
    try {
      js = await pdfjsLib.getDocument({ data: bytes.slice(), password, isEvalSupported: false }).promise;
      break;
    } catch (err) {
      if (err?.name !== 'PasswordException') throw new Error(`“${file.name}” is not a readable PDF.`);
      password = await askPassword(file.name, attempt > 0);
      if (password == null) throw new Error('cancelled');
    }
  }
  return { file, name: file.name, size: file.size, bytes, password, js, pages: js.numPages };
}

// pdf-lib copy of a loaded PDF. Files with only an owner password open with
// an empty one; pdf-lib still has to be told to decrypt them.
export async function loadLib(doc) {
  const opts = { updateMetadata: false };
  let lib;
  try {
    lib = await PDFDocument.load(doc.bytes, { ...opts, password: doc.password });
  } catch (err) {
    if (!(err instanceof window.PDFLib.EncryptedPDFError || /encrypted/i.test(err?.message))) throw err;
    lib = await PDFDocument.load(doc.bytes, { ...opts, password: doc.password ?? '' });
  }
  if (lib.context.isDecrypted) scrubEncryption(lib);
  return lib;
}

// After decrypting, the old encryption dictionary, the original xref stream
// (which still names it) and the unpacked object streams stay in the file.
// Saved as-is, other readers would think the result is still locked.
function scrubEncryption(lib) {
  const { PDFName, PDFDict, PDFInvalidObject } = window.PDFLib;
  const N = (n) => PDFName.of(n);
  const dead = [];
  for (const [ref, obj] of lib.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFInvalidObject) {
      const raw = obj.data ? new TextDecoder('latin1').decode(obj.data) : '';
      if (/\/Type\s*\/XRef|\/Encrypt/.test(raw)) dead.push(ref);
      continue;
    }
    const d = obj instanceof PDFDict ? obj : obj?.dict;
    if (!(d instanceof PDFDict)) continue;
    const type = d.get(N('Type'))?.toString();
    if (type === '/XRef' || type === '/ObjStm' || d.get(N('Filter'))?.toString() === '/Standard' || (d.has(N('Encrypt')) && d.has(N('Root')))) dead.push(ref);
  }
  dead.forEach((r) => lib.context.delete(r));
}

export function askPassword(name, wrong) {
  return modal({
    title: 'This PDF has a password',
    body: (m) => {
      const input = h('input', { type: 'password', class: 'field', placeholder: 'Password', autocomplete: 'off' });
      m.value = () => input.value;
      setTimeout(() => input.focus(), 30);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && m.ok());
      return [h('p', {}, wrong ? 'That password did not work. Try again.' : `Enter the password to open “${name}”.`), input];
    },
    okText: 'Open',
  });
}

// Small promise-based dialog. body(m) returns nodes and may set m.value().
export function modal({ title, body, okText = 'OK', cancelText = 'Cancel', wide = false }) {
  return new Promise((resolve) => {
    const m = { value: () => true };
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    m.ok = () => close(m.value());
    m.cancel = () => close(null);
    const onKey = (e) => e.key === 'Escape' && m.cancel();
    const wrap = h('div', { class: 'modal', onclick: (e) => e.target === wrap && m.cancel() },
      h('div', { class: 'modal__box' + (wide ? ' modal__box--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', {}, title),
        h('div', { class: 'modal__body' }, body(m)),
        h('div', { class: 'modal__actions' },
          cancelText && h('button', { class: 'btn btn--ghost', onclick: m.cancel }, cancelText),
          h('button', { class: 'btn btn--solid', onclick: m.ok }, okText))));
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
  });
}

/* ---------- rendering pages ---------- */

// Renders one page into a canvas `width` CSS pixels wide.
// Thumbnails go through a small queue so a 300-page file doesn't freeze the tab.
const queue = [];
let running = 0;
function pump() {
  while (running < 3 && queue.length) {
    const job = queue.shift();
    running++;
    job().finally(() => { running--; pump(); });
  }
}
export function renderPage(js, index, width, { canvas = h('canvas'), lazy = true, scale: fixedScale } = {}) {
  const run = async () => {
    const page = await js.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = fixedScale || (width / base.width);
    const vp = page.getViewport({ scale: scale * (fixedScale ? 1 : dpr) });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    if (!fixedScale) { canvas.style.width = width + 'px'; canvas.style.aspectRatio = `${base.width} / ${base.height}`; }
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    page.cleanup();
    return canvas;
  };
  if (!lazy) return run();
  return new Promise((resolve, reject) => { queue.push(() => run().then(resolve, reject)); pump(); });
}

export async function pageSizes(js) {
  const out = [];
  for (let i = 1; i <= js.numPages; i++) {
    const p = await js.getPage(i);
    const v = p.getViewport({ scale: 1 });
    out.push({ w: v.width, h: v.height, rotate: p.rotate });
  }
  return out;
}

/* ---------- page geometry ---------- */

// Maps a point on the page *as the reader sees it* (top-left origin, after
// /Rotate) to PDF user space, and gives the rotation that keeps drawn
// things upright. Every tool that stamps onto pages goes through this.
export function pageFrame(page) {
  const { x: cx, y: cy, width: cw, height: ch } = page.getCropBox();
  const R = ((page.getRotation().angle % 360) + 360) % 360;
  const side = R === 90 || R === 270;
  const W = side ? ch : cw;
  const H = side ? cw : ch;
  const map = (dx, dy) => {
    switch (R) {
      case 90: return { x: cx + dy, y: cy + dx };
      case 180: return { x: cx + cw - dx, y: cy + dy };
      case 270: return { x: cx + cw - dy, y: cy + ch - dx };
      default: return { x: cx + dx, y: cy + ch - dy };
    }
  };
  return { W, H, R, map };
}

// Where to put the bottom-left corner of a w×h box centred at (cx, cy) in
// view space, turned `theta` degrees anticlockwise, so it can be drawn with
// rotate = R + theta.
export function boxAnchor(frame, cx, cy, w, hgt, theta = 0) {
  const t = (theta * Math.PI) / 180;
  const ox = (-w / 2) * Math.cos(t) - (-hgt / 2) * Math.sin(t);
  const oy = (-w / 2) * Math.sin(t) + (-hgt / 2) * Math.cos(t);
  return { ...frame.map(cx + ox, cy - oy), rotate: degrees(frame.R + theta) };
}

/* ---------- page ranges ---------- */

// "1-3, 5, 8-" -> [0,1,2,4,7,8,...] (0-based, in the order written).
export function parseRanges(text, count) {
  const out = [];
  const parts = String(text).split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) throw new Error('Type the pages, for example 1-3, 5');
  for (const part of parts) {
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$|^(\d+)$/);
    if (!m) throw new Error(`“${part}” is not a page or a range.`);
    let a, b;
    if (m[3]) a = b = +m[3];
    else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : count; }
    if (a < 1 || b < 1 || a > count || b > count) throw new Error(`This PDF has ${count} pages; “${part}” is outside that.`);
    const step = a <= b ? 1 : -1;
    for (let i = a; i !== b + step; i += step) out.push(i - 1);
  }
  return out;
}

/* ---------- text that the built-in fonts can't draw ---------- */

// The 14 standard PDF fonts only cover Western European letters. Anything
// else (Urdu, Arabic, Hindi, emoji…) is drawn by the browser into a PNG and
// placed as an image, so it always shows correctly.
// (This pdf-lib build swaps missing letters for "?" instead of failing, so
// check against the font's own character list.)
const charSets = new WeakMap();
export function fontCanDraw(font, text) {
  if (!charSets.has(font)) charSets.set(font, new Set(font.getCharacterSet()));
  const set = charSets.get(font);
  for (const ch of String(text)) if (ch !== '\n' && !set.has(ch.codePointAt(0))) return false;
  return true;
}

export async function textAsPng(text, { family = 'Helvetica, Arial, sans-serif', bold = false, italic = false, size = 24, color = '#000', lineHeight = 1.25 }) {
  const px = size * 4; // 4x for crisp print
  const font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${px}px ${family}`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  const lines = String(text).split('\n');
  const lh = px * lineHeight;
  const w = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  c.width = Math.ceil(w + px * 0.2);
  c.height = Math.ceil(lh * lines.length);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.direction = 'inherit';
  lines.forEach((l, i) => ctx.fillText(l, px * 0.1, i * lh + lh / 2));
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width / 4, height: c.height / 4 };
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/* ---------- images ---------- */

// Decodes any browser-readable image (EXIF rotation applied) and returns
// bytes pdf-lib can embed: PNG when it has transparency, JPEG otherwise.
export async function imageForPdf(file, { maxSide = 0, quality = 0.92, keepAlpha = true } = {}) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let { width, height } = bmp;
  if (maxSide && Math.max(width, height) > maxSide) {
    const k = maxSide / Math.max(width, height);
    width = Math.round(width * k); height = Math.round(height * k);
  }
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  const png = keepAlpha && /png|gif|webp/i.test(file.type) && hasAlpha(ctx, width, height);
  if (!png) { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
  const blob = await new Promise((r) => c.toBlob(r, png ? 'image/png' : 'image/jpeg', quality));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), png, width, height };
}

function hasAlpha(ctx, w, h) {
  const step = Math.max(1, Math.floor((w * h) / 40000));
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4 * step) if (d[i] < 250) return true;
  return false;
}

/* ---------- drag to reorder ---------- */

// Mouse: drag the whole card. Touch: drag by the grip (so the page still
// scrolls). Calls onDone(newOrder) with the cards' data-id values.
export function sortable(container, onDone) {
  container.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('[data-id]');
    if (!item || !container.contains(item) || e.button > 0) return;
    if (e.target.closest('button, input, select, a')) return;
    if (e.pointerType !== 'mouse' && !e.target.closest('.grip')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const r = item.getBoundingClientRect();
    let ghost = null;
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        ghost = item.cloneNode(true);
        // cloneNode doesn't copy canvas pixels
        const src = item.querySelectorAll('canvas'), dst = ghost.querySelectorAll('canvas');
        src.forEach((c, i) => { dst[i].width = c.width; dst[i].height = c.height; dst[i].getContext('2d').drawImage(c, 0, 0); });
        Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', pointerEvents: 'none', zIndex: 50 });
        ghost.classList.add('ghost');
        document.body.append(ghost);
        item.classList.add('placeholder');
      }
      ghost.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px) rotate(2deg)`;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-id]');
      if (over && over !== item && container.contains(over)) {
        const or = over.getBoundingClientRect();
        const after = ev.clientX > or.left + or.width / 2;
        over.parentNode.insertBefore(item, after ? over.nextSibling : over);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!ghost) return;
      ghost.remove();
      item.classList.remove('placeholder');
      onDone([...container.querySelectorAll(':scope > [data-id]')].map((el) => el.dataset.id));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

export const uid = () => Math.random().toString(36).slice(2, 10);
