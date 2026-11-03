// OCR PDF, Redact PDF and Compare PDF.
import {
  h, icon, registerIcons, busy, toast, tick, PDFDocument, StandardFonts, rgb, degrees, loadLib, loadScript,
  renderPage, pageSizes, pageFrame, boxAnchor, fontCanDraw, baseName,
} from '../core.js';
import { field, segmented, check, fileRow, pageGrid, pdfOut } from '../ui.js';

registerIcons({
  secOcr: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
  secRedact: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 12.5h7M8.5 16.5h4" stroke-width="3"/>',
  secCompare: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/><path d="M6 9h1M6 13h1M17 9h1M17 13h1"/>',
  secSwap: '<path d="m7 4-4 4 4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/>',
  secDraw: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M12 9v6M9 12h6"/>',
});

const vendorUrl = (path) => new URL('../../vendor/' + path, import.meta.url).href;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
const andList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const pct = (b, p) => ({ left: (b.x / p.W) * 100 + '%', top: (b.y / p.H) * 100 + '%', width: (b.w / p.W) * 100 + '%', height: (b.h / p.H) * 100 + '%' });
const screenPx = (cssWidth) => Math.min(1600, Math.round(cssWidth * Math.min(window.devicePixelRatio || 1, 2)));

/* ---------- a page's text, with positions ---------- */

// Every character of a page's text and where it is in view space (points,
// top-left origin, after /Rotate). boxes(a, b) covers characters a..b-1 with
// one rectangle per text run, so a match across two lines isn't one huge box.
const texts = new WeakMap();
function pageText(js, i) {
  if (!texts.has(js)) texts.set(js, []);
  const cache = texts.get(js);
  cache[i] ||= (async () => {
    const page = await js.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    page.cleanup();
    let text = '';
    const runs = [];
    const at = []; // per character: [run, index in run], or null (no position)
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      if (it.str && it.width > 0) {
        const t = window.pdfjsLib.Util.transform(vp.transform, it.transform);
        const size = Math.hypot(t[2], t[3]) || 1;
        const len = Math.hypot(t[0], t[1]) || 1;
        runs.push({ ox: t[4], oy: t[5], ux: t[0] / len, uy: t[1] / len, vx: t[2] / size, vy: t[3] / size, size, w: it.width, n: it.str.length });
        for (let k = 0; k < it.str.length; k++) at.push([runs.length - 1, k]);
      } else for (let k = 0; k < it.str.length; k++) at.push(null);
      text += it.str;
      if (it.hasEOL) { text += '\n'; at.push(null); }
    }
    const W = vp.width, H = vp.height;
    const rect = (r, k0, k1) => {
      const xs = [], ys = [];
      for (const t of [k0 / r.n, (k1 + 1) / r.n]) for (const s of [-0.25, 0.95]) {
        xs.push(r.ox + r.ux * r.w * t + r.vx * r.size * s);
        ys.push(r.oy + r.uy * r.w * t + r.vy * r.size * s);
      }
      const x = clamp(Math.min(...xs), 0, W), y = clamp(Math.min(...ys), 0, H);
      return { x, y, w: clamp(Math.max(...xs), 0, W) - x, h: clamp(Math.max(...ys), 0, H) - y };
    };
    const boxes = (a, b) => {
      const out = [];
      let cur = null;
      for (let c = a; c < b; c++) {
        const p = at[c];
        if (!p) continue;
        if (cur && cur.r === p[0] && cur.k1 === p[1] - 1) cur.k1 = p[1];
        else { if (cur) out.push(rect(runs[cur.r], cur.k0, cur.k1)); cur = { r: p[0], k0: p[1], k1: p[1] }; }
      }
      if (cur) out.push(rect(runs[cur.r], cur.k0, cur.k1));
      return out.filter((r) => r.w > 0.5 && r.h > 0.5);
    };
    return { text, W, H, boxes };
  })();
  return cache[i];
}

const hasText = async (js, i) => /\S/.test((await pageText(js, i)).text);
const allPages = (doc) => [...Array(doc.pages).keys()];

/* ---------- fonts for any of our languages ---------- */

const NOTO = { latin: 'NotoSans-Regular.ttf', arabic: 'NotoSansArabic-Regular.ttf', deva: 'NotoSansDevanagari-Regular.ttf' };
const notoBytes = new Map();
const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;
const UNJOINED = { init: false, medi: false, fina: false, isol: false, rlig: false, liga: false, calt: false, mset: false, ccmp: false };

// pick(text, bold) gives a font of `lib` that can encode the text: Helvetica
// when it can, otherwise a Noto font subset into the PDF. fontkit and the
// font files load the first time one is needed. `invisible` text only has to
// be found and copied: Arabic letters then stay unjoined, because the joined
// forms come out of the font as glyphs with no Unicode value.
function fontPicker(lib, { invisible = false } = {}) {
  const fonts = {};
  const get = (key) => (fonts[key] ||= (async () => {
    if (key === 'helv') return lib.embedFont(StandardFonts.Helvetica);
    if (key === 'bold') return lib.embedFont(StandardFonts.HelveticaBold);
    await loadScript('vendor/fontkit/fontkit.umd.min.js');
    lib.registerFontkit(window.fontkit);
    if (!notoBytes.has(key)) {
      notoBytes.set(key, fetch(vendorUrl('noto/' + NOTO[key])).then((r) => {
        if (!r.ok) throw new Error('Could not load a part of PDF Tools. Check your connection and try again.');
        return r.arrayBuffer();
      }).catch((err) => { notoBytes.delete(key); throw err; }));
    }
    return lib.embedFont(await notoBytes.get(key), { subset: true, features: invisible && key === 'arabic' ? UNJOINED : undefined });
  })());
  return async (text, bold = false) => {
    const base = await get(bold ? 'bold' : 'helv');
    if (fontCanDraw(base, text)) return base;
    return get(ARABIC.test(text) ? 'arabic' : /[\u0900-\u097f]/.test(text) ? 'deva' : 'latin');
  };
}

/* ---------- OCR ---------- */

// Language models download from jsDelivr (@tesseract.js-data/<code>/4.0.0_best_int)
// and Tesseract keeps them in the browser afterwards. Sizes in MB.
const LANGS = [
  ['eng', 'English', 2.9], ['urd', 'Urdu', 1.0], ['ara', 'Arabic', 1.7], ['fas', 'Persian', 0.4],
  ['hin', 'Hindi', 1.4], ['fra', 'French', 0.7], ['deu', 'German', 1.3], ['spa', 'Spanish', 2.1],
  ['ita', 'Italian', 1.7], ['por', 'Portuguese', 1.4], ['nld', 'Dutch', 3.0], ['tur', 'Turkish', 2.1],
  ['pol', 'Polish', 2.6], ['rus', 'Russian', 2.7], ['ind', 'Indonesian', 1.2],
];
const BROWSER_LANG = { ur: 'urd', ar: 'ara', fa: 'fas', hi: 'hin', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', tr: 'tur', pl: 'pol', ru: 'rus', id: 'ind' };

const ocr = {
  id: 'ocr', keywords: 'scan searchable text recognition image to text', title: 'OCR PDF', icon: 'secOcr', color: '#0d9488', cat: 'optimize', action: 'Make searchable', wide: true, busyText: 'Getting ready…',
  desc: 'Make a scanned PDF searchable and its text copyable.',
  long: 'Reads the text in scanned pages and adds it to the PDF invisibly, so you can search, select and copy it. The pages look exactly the same.',
  setup(ctx) {
    const doc = ctx.items[0];
    const own = BROWSER_LANG[(navigator.language || '').slice(0, 2)];
    const s = ctx.state = { langs: own ? ['eng', own] : ['eng'], skip: true, withText: null };
    const grid = pageGrid(doc);
    const status = h('p', { class: 'muted small' }, 'Checking which pages already have text…');
    const note = h('p', { class: 'sec-note' });
    const langs = h('div', { class: 'sec-langs', role: 'group', 'aria-label': 'Languages in the document' });
    const update = () => {
      const picked = LANGS.filter(([code]) => s.langs.includes(code));
      const mb = picked.reduce((t, l) => t + l[2], 0);
      note.replaceChildren(icon('download'), h('span', {}, picked.length
        ? `Downloads the ${andList(picked.map((l) => l[1]))} language model${picked.length > 1 ? 's' : ''} (about ${mb.toFixed(1)} MB) the first time. Your PDF stays on this device.`
        : 'Pick the languages your document is in.'));
      const todo = s.withText ? s.withText.filter((t) => !(s.skip && t)).length : doc.pages;
      ctx.action.disabled = !picked.length || !todo;
      if (!s.withText) return;
      const n = s.withText.filter(Boolean).length;
      status.textContent = !n ? `No page has text yet. ${doc.pages === 1 ? 'The page' : `All ${doc.pages} pages`} will be read.`
        : !todo ? 'Every page already has text, so there is nothing to read. Turn off the option above to read them again.'
          : s.skip ? `${plural(n, 'page')} already ${n === 1 ? 'has' : 'have'} text and will be left as ${n === 1 ? 'it is' : 'they are'}. ${plural(todo, 'page')} will be read.`
            : `All ${plural(doc.pages, 'page')} will be read.`;
      status.classList.toggle('bad', !todo);
    };
    const drawLangs = () => langs.replaceChildren(...LANGS.map(([code, name]) => {
      const on = s.langs.includes(code);
      return h('button', { type: 'button', class: 'sec-lang' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => {
        s.langs = on ? s.langs.filter((c) => c !== code) : [...s.langs, code];
        drawLangs(); update();
      } }, on && icon('check'), name);
    }));
    ctx.main.append(grid);
    ctx.side.append(
      fileRow(doc),
      h('div', { class: 'f' }, h('span', { class: 'f__label' }, 'Languages in the document'), langs),
      note,
      check('Skip pages that already have text', s.skip, (v) => { s.skip = v; update(); }),
      status,
      h('p', { class: 'muted small' }, 'Reading takes a few seconds per page. Clear, straight scans work best, and each extra language makes it a little slower.'));
    drawLangs();
    update();
    Promise.all(allPages(doc).map((i) => hasText(doc.js, i).catch(() => false))).then((r) => {
      s.withText = r;
      r.forEach((t, i) => t && grid.querySelector(`.pg[data-i="${i}"]`)?.append(h('span', { class: 'sec-tag' }, 'Has text')));
      update();
    });
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    const withText = s.withText || await Promise.all(allPages(doc).map((i) => hasText(doc.js, i)));
    const want = allPages(doc).filter((i) => !(s.skip && withText[i]));
    if (!want.length) throw new Error('Every page already has text.');
    busy('Loading the text reader…');
    await loadScript('vendor/tesseract/tesseract.min.js');
    let reading = '';
    let worker;
    try {
      worker = await window.Tesseract.createWorker(s.langs.join('+'), 1, {
        workerPath: vendorUrl('tesseract/worker.min.js'),
        corePath: vendorUrl('tesseract/core'),
        logger: (m) => {
          const pct = Math.round((m.progress || 0) * 100);
          if (m.status === 'recognizing text') busy(`${reading} ${pct}%`);
          else if (/loading language/.test(m.status)) busy(`Getting the language model… ${pct}%`);
        },
      });
    } catch (err) {
      console.error(err);
      throw new Error('Could not download the language model. Check your connection and try again.');
    }
    const lib = await loadLib(doc);
    const pick = fontPicker(lib, { invisible: true });
    let words = 0;
    try {
      for (const [n, i] of want.entries()) {
        reading = want.length > 1 ? `Reading page ${n + 1} of ${want.length}…` : 'Reading the page…';
        busy(reading);
        const page = lib.getPage(i);
        const f = pageFrame(page);
        // About 300 dpi, but no bigger than Tesseract handles comfortably.
        const scale = Math.min(300 / 72, 4200 / Math.max(f.W, f.H));
        const canvas = await renderPage(doc.js, i, 0, { lazy: false, scale });
        const { data } = await worker.recognize(canvas, {}, { blocks: true });
        words += await addTextLayer(page, f, data, canvas.width / f.W, pick);
        canvas.width = canvas.height = 0;
      }
    } finally {
      worker.terminate();
    }
    busy('Saving…');
    await tick();
    const skipped = doc.pages - want.length;
    return {
      files: [pdfOut(`${baseName(doc.name)}-ocr.pdf`, await lib.save())],
      title: words ? 'Your PDF is searchable' : 'No text was found',
      note: (words ? `Found ${plural(words, 'word')} on ${plural(want.length, 'page')}.` : 'The pages may be blank or blurry, or in a language you did not pick.')
        + (skipped ? ` ${plural(skipped, 'page')} already had text and ${skipped === 1 ? 'was' : 'were'} left as ${skipped === 1 ? 'it was' : 'they were'}.` : ''),
    };
  },
};

// Writes each recognized word as invisible text (render mode 3) on top of the
// word in the scan, stretched to the word's width, so searching and selecting
// line up with what you see. The page's own content is kept. `px` is image
// pixels per point.
async function addTextLayer(page, f, data, px, pick) {
  const L = window.PDFLib;
  const ops = [];
  const keys = new Map();
  for (const block of data.blocks || []) for (const para of block.paragraphs) for (const line of para.lines) {
    const ra = line.rowAttributes || {};
    const size = (ra.rowHeight || ra.row_height || line.bbox.y1 - line.bbox.y0) / px;
    const bl = line.baseline;
    for (const w of line.words) {
      const text = w.text.trim();
      if (!text || w.confidence < 20 || size < 1) continue;
      const font = await pick(text);
      const natural = font.widthOfTextAtSize(text, size);
      if (!natural) continue;
      if (!keys.has(font)) keys.set(font, page.node.newFontDictionary(font.name, font.ref));
      const mid = (w.bbox.x0 + w.bbox.x1) / 2;
      const base = bl && bl.x1 > bl.x0 ? bl.y0 + ((bl.y1 - bl.y0) * (mid - bl.x0)) / (bl.x1 - bl.x0) : w.bbox.y1 - size * px * 0.2;
      const { x, y } = f.map(w.bbox.x0 / px, base / px);
      // A trailing space helps readers that don't infer word gaps. In
      // right-to-left words it would land on the wrong side, so they go without.
      const shown = ARABIC.test(text) ? text : text + ' ';
      ops.push(
        L.setFontAndSize(keys.get(font), size),
        L.setCharacterSqueeze(clamp((100 * (w.bbox.x1 - w.bbox.x0)) / px / natural, 5, 1000)),
        L.rotateAndSkewTextDegreesAndTranslate(f.R, 0, 0, x, y),
        L.showText(font.encodeText(shown)));
    }
  }
  if (!ops.length) return 0;
  // Wraps the page's own content in q…Q, so our text starts from a clean state.
  page.translateContent(0, 0);
  page.pushOperators(L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible), ...ops, L.endText(), L.popGraphicsState());
  return ops.length / 4;
}

/* ---------- REDACT ---------- */

const PRESETS = [
  ['email', 'Email addresses', /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['phone', 'Phone numbers', /\+?\(?\d[\d ().-]{5,}\d/g, (m) => { const n = m.replace(/\D/g, '').length; return n >= 7 && n <= 15; }],
  // A number that starts with "+" is a phone number; taking it whole keeps its tail out too.
  ['number', 'Card and ID numbers', /(?<!\d)\+?\d(?:[ -]?\d){7,22}/g, (m) => !m.startsWith('+')],
];

const redact = {
  id: 'redact', keywords: 'black out hide remove censor sensitive private', title: 'Redact PDF', icon: 'secRedact', color: '#1f2937', cat: 'security', action: 'Redact PDF', wide: true, busyText: 'Redacting…',
  desc: 'Black out private text and pictures for good.',
  long: 'Draw boxes over anything private, or find words, emails and numbers to mark them. What you mark is taken out of the file, not just covered.',
  async setup(ctx) {
    const doc = ctx.items[0];
    const sizes = await pageSizes(doc.js);
    const hand = { id: 'hand', label: 'Drawn by hand', boxes: [] };
    const s = ctx.state = { groups: [], info: true, dpi: 200, draw: true, sel: null };
    const pagesEl = h('div', { class: 'sec-pages drawing' });
    const pageEls = sizes.map(({ w: W, h: H }, i) => {
      const canvas = h('canvas');
      const layer = h('div', { class: 'sec-layer' });
      const el = h('div', { class: 'sec-page', style: { aspectRatio: `${W} / ${H}` }, 'data-page': i }, canvas, layer, h('span', { class: 'sec-page__num' }, String(i + 1)));
      layer.addEventListener('pointerdown', (e) => startBox(e, i, layer, W, H));
      pagesEl.append(el);
      return { el, canvas, layer, W, H, drawn: false };
    });
    // Pages render when they come near the view.
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      const p = pageEls[+en.target.dataset.page];
      if (!en.isIntersecting || p.drawn) return;
      p.drawn = true;
      renderPage(doc.js, +en.target.dataset.page, 0, { canvas: p.canvas, scale: screenPx(p.el.clientWidth) / p.W }).catch(() => (p.drawn = false));
    }), { root: pagesEl, rootMargin: '400px 0px' });
    pageEls.forEach((p) => io.observe(p.el));

    const where = h('span', { class: 'sec-bar__where' });
    const prev = h('button', { class: 'iconbtn', 'aria-label': 'Previous page', onclick: () => goTo(current() - 1) }, icon('back'));
    const next = h('button', { class: 'iconbtn flip', 'aria-label': 'Next page', onclick: () => goTo(current() + 1) }, icon('back'));
    // Off, a finger scrolls the pages instead of drawing.
    const drawBtn = h('button', { type: 'button', class: 'btn btn--ghost sec-drawbtn on', 'aria-pressed': 'true', onclick: () => {
      s.draw = !s.draw;
      drawBtn.classList.toggle('on', s.draw);
      drawBtn.setAttribute('aria-pressed', String(s.draw));
      pagesEl.classList.toggle('drawing', s.draw);
    } }, icon('secDraw'), 'Draw boxes');
    const current = () => {
      const top = pagesEl.getBoundingClientRect().top + 40;
      const k = pageEls.findIndex((p) => p.el.getBoundingClientRect().bottom > top);
      return k < 0 ? pageEls.length - 1 : k;
    };
    const goTo = (i) => {
      const p = pageEls[clamp(i, 0, pageEls.length - 1)];
      pagesEl.scrollTo({ top: p.el.offsetTop - 12, behavior: 'smooth' });
    };
    const syncWhere = () => {
      const k = current();
      where.textContent = `Page ${k + 1} of ${doc.pages}`;
      prev.disabled = k === 0;
      next.disabled = k === doc.pages - 1;
    };
    pagesEl.addEventListener('scroll', syncWhere, { passive: true });
    new ResizeObserver(syncWhere).observe(pagesEl);

    const allBoxes = () => s.groups.flatMap((g) => g.boxes);
    const boxEl = (b) => {
      const el = h('div', { class: 'sec-box' + (s.sel === b ? ' sel' : ''), style: pct(b, pageEls[b.page]) },
        h('button', { type: 'button', class: 'sec-box__x', 'aria-label': 'Remove this mark', onclick: () => removeBox(b) }, icon('x')));
      el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) { s.sel = b; paint(); } });
      return el;
    };
    const paint = () => {
      pageEls.forEach((p) => p.layer.replaceChildren());
      for (const b of allBoxes()) pageEls[b.page].layer.append(boxEl(b));
      drawList();
    };
    const removeBox = (b) => {
      for (const g of s.groups) {
        if (!g.boxes.includes(b)) continue;
        g.boxes = g.boxes.filter((x) => x !== b);
        if (g.hits) g.hits = new Set(g.boxes.map((x) => x.hit)).size;
      }
      s.groups = s.groups.filter((g) => g.boxes.length);
      if (s.sel === b) s.sel = null;
      paint();
    };

    function startBox(e, page, layer, W, H) {
      if (!s.draw || e.button > 0 || e.target !== layer) return;
      e.preventDefault();
      const r = layer.getBoundingClientRect();
      const k = W / r.width;
      const pt = (ev) => ({ x: clamp((ev.clientX - r.left) * k, 0, W), y: clamp((ev.clientY - r.top) * k, 0, H) });
      const a = pt(e);
      const b = { page, x: a.x, y: a.y, w: 0, h: 0 };
      const live = h('div', { class: 'sec-box live' });
      layer.append(live);
      layer.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const q = pt(ev);
        Object.assign(b, { x: Math.min(a.x, q.x), y: Math.min(a.y, q.y), w: Math.abs(q.x - a.x), h: Math.abs(q.y - a.y) });
        Object.assign(live.style, pct(b, pageEls[page]));
      };
      const end = () => {
        layer.removeEventListener('pointermove', move);
        layer.removeEventListener('pointerup', end);
        layer.removeEventListener('pointercancel', end);
        live.remove();
        if (b.w < 3 || b.h < 3) { if (s.sel) { s.sel = null; paint(); } return; }
        if (!s.groups.includes(hand)) s.groups.push(hand);
        hand.boxes.push(b);
        s.sel = b;
        paint();
      };
      layer.addEventListener('pointermove', move);
      layer.addEventListener('pointerup', end);
      layer.addEventListener('pointercancel', end);
    }

    const onKey = (e) => {
      if (!pagesEl.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.sel && !e.target.closest('input, textarea')) { e.preventDefault(); removeBox(s.sel); }
    };
    document.addEventListener('keydown', onKey);

    // Marks every match of `re` on every page, as one group in the list.
    const find = async (id, label, re, keep = () => true) => {
      busy('Searching…');
      const g = { id, label, boxes: [], hits: 0 };
      try {
        for (let i = 0; i < doc.pages; i++) {
          const t = await pageText(doc.js, i);
          for (const m of t.text.matchAll(re)) {
            if (!m[0].trim() || !keep(m[0])) continue;
            const found = t.boxes(m.index, m.index + m[0].length);
            if (!found.length) continue;
            g.hits++;
            g.boxes.push(...found.map((r) => ({ page: i, hit: g.hits, x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 })));
          }
        }
      } finally { busy(false); }
      if (!g.hits) {
        const scan = (await Promise.all(allPages(doc).map((i) => hasText(doc.js, i)))).every((x) => !x);
        toast(scan ? 'This PDF has no text to search. It is probably a scan: draw boxes instead, or run OCR PDF on it first.'
          : id.startsWith('q:') ? `No matches for ${label}.` : `No ${label[0].toLowerCase() + label.slice(1)} found.`);
        return;
      }
      s.groups = s.groups.filter((x) => x.id !== id);
      s.groups.push(g);
      paint();
      goTo(g.boxes[0].page);
    };
    const query = h('input', { class: 'field', type: 'search', placeholder: 'A name, a number…', enterkeyhint: 'search', 'aria-label': 'Text to find', onkeydown: (e) => e.key === 'Enter' && findQuery() });
    const findQuery = () => {
      const q = query.value.trim();
      if (!q) { query.focus(); return; }
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
      find('q:' + q.toLowerCase(), `“${q}”`, re);
    };

    const marks = h('div', { class: 'sec-marks' });
    const drawList = () => {
      const all = allBoxes();
      ctx.action.disabled = !all.length;
      if (!s.groups.length) { marks.replaceChildren(h('p', { class: 'muted small' }, 'Nothing marked yet.')); return; }
      marks.replaceChildren(...s.groups.map((g) => {
        const pages = [...new Set(g.boxes.map((b) => b.page + 1))].sort((a, b) => a - b);
        return h('div', { class: 'sec-mark' },
          h('button', { type: 'button', class: 'sec-mark__go', onclick: () => goTo(g.boxes[0].page) },
            h('strong', {}, g.label),
            h('span', {}, `${g === hand ? plural(g.boxes.length, 'box', 'boxes') : plural(g.hits, 'match', 'matches')} · page${pages.length > 1 ? 's' : ''} ${pages.slice(0, 6).join(', ')}${pages.length > 6 ? '…' : ''}`)),
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': `Remove ${g.label}`, onclick: () => { s.groups = s.groups.filter((x) => x !== g); if (g === hand) hand.boxes = []; paint(); } }, icon('x')));
      }), h('p', { class: 'muted small' }, `${plural(new Set(all.map((b) => b.page)).size, 'page')} will be redacted.`));
    };

    ctx.main.append(h('div', { class: 'sec-view' },
      h('div', { class: 'sec-bar' }, drawBtn, h('span', { class: 'sec-bar__gap' }), prev, where, next),
      pagesEl));
    ctx.side.append(
      h('p', {}, 'Drag on a page to cover something, or find text to mark every place it appears.'),
      field('Find text', h('div', { class: 'sec-find' }, query, h('button', { type: 'button', class: 'btn btn--soft', onclick: findQuery }, icon('search'), 'Mark'))),
      h('div', { class: 'f' }, h('span', { class: 'f__label' }, 'Find all'),
        h('div', { class: 'sec-presets' }, PRESETS.map(([id, label, re, keep]) =>
          h('button', { type: 'button', class: 'chip', onclick: () => find(id, label, re, keep) }, label)))),
      h('div', { class: 'f' }, h('span', { class: 'f__label' }, 'Marked'), marks),
      field('Redacted pages', segmented([[200, 'Standard'], [300, 'Sharper']], s.dpi, (v) => (s.dpi = v))),
      check('Also remove document info (title, author, keywords…)', s.info, (v) => (s.info = v)),
      h('p', { class: 'muted small' }, 'Pages with marks become images with the marks burned in, so what is under them is really gone. Text on those pages can no longer be selected or searched, and their links and form fields are removed. Other pages stay as they are.'));
    paint();
    syncWhere();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    const boxes = s.groups.flatMap((g) => g.boxes);
    const pages = [...new Set(boxes.map((b) => b.page))].sort((a, b) => a - b);
    const lib = await loadLib(doc);
    const N = (n) => window.PDFLib.PDFName.of(n);
    dropFields(lib, pages);
    for (const [k, i] of pages.entries()) {
      busy(`Redacting page ${k + 1} of ${pages.length}…`);
      const page = lib.getPage(i);
      const f = pageFrame(page);
      const canvas = await rasterize(doc.js, i, Math.min(s.dpi / 72, 6000 / Math.max(f.W, f.H)));
      const kx = canvas.width / f.W, ky = canvas.height / f.H;
      const c = canvas.getContext('2d');
      c.fillStyle = '#000';
      for (const b of boxes) if (b.page === i) {
        const x = Math.floor(b.x * kx), y = Math.floor(b.y * ky);
        c.fillRect(x, y, Math.ceil((b.x + b.w) * kx) - x, Math.ceil((b.y + b.h) * ky) - y);
      }
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      canvas.width = canvas.height = 0;
      const img = await lib.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      blankPage(lib, page);
      // The picture goes on upright as the page is shown, at the page's own size.
      const g = pageFrame(page);
      const a = boxAnchor(g, g.W / 2, g.H / 2, g.W, g.H);
      page.drawImage(img, { x: a.x, y: a.y, width: g.W, height: g.H, rotate: a.rotate });
    }
    if (pages.length) {
      // Tags can repeat a page's text (alternate and actual text).
      lib.catalog.delete(N('StructTreeRoot'));
      lib.catalog.delete(N('MarkInfo'));
    }
    if (s.info) {
      lib.context.trailerInfo.Info = undefined;
      lib.catalog.delete(N('Metadata'));
    }
    dropUnreachable(lib);
    busy('Saving…');
    await tick();
    return {
      files: [pdfOut(`${baseName(doc.name)}-redacted.pdf`, await lib.save({ updateFieldAppearances: false }))],
      title: 'Your PDF is redacted',
      note: `${plural(boxes.length, 'area')} removed on ${plural(pages.length, 'page')}.${s.info ? ' Document info removed too.' : ''}`,
    };
  },
};

// A page as shown (rotation applied), with form fields and other annotations,
// since those are taken off redacted pages.
async function rasterize(js, i, scale) {
  const page = await js.getPage(i + 1);
  const vp = page.getViewport({ scale });
  const canvas = h('canvas', { width: Math.round(vp.width), height: Math.round(vp.height) });
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, annotationMode: window.pdfjsLib.AnnotationMode.ENABLE }).promise;
  page.cleanup();
  return canvas;
}

// Empties a page down to its size and rotation: no content, fonts, images,
// links, form fields, thumbnails or tags are left on it.
function blankPage(lib, page) {
  const N = (n) => window.PDFLib.PDFName.of(n);
  const { x, y, width, height } = page.getCropBox();
  const R = page.getRotation().angle;
  for (const key of page.node.keys()) if (key !== N('Type') && key !== N('Parent')) page.node.delete(key);
  page.node.set(N('MediaBox'), lib.context.obj([x, y, x + width, y + height]));
  page.node.set(N('Resources'), lib.context.obj({}));
  page.setRotation(degrees(R));
}

// A form field with a widget on a redacted page still holds its value in the
// document's form, so the whole field goes.
function dropFields(lib, pages) {
  const { PDFName, PDFDict, PDFArray, PDFRef } = window.PDFLib;
  const N = (n) => PDFName.of(n);
  const fields = lib.catalog.lookupMaybe(N('AcroForm'), PDFDict)?.lookupMaybe(N('Fields'), PDFArray);
  if (!fields) return;
  const roots = new Set();
  for (const i of pages) {
    const annots = lib.getPage(i).node.lookupMaybe(N('Annots'), PDFArray);
    for (let k = 0; k < (annots?.size() ?? 0); k++) {
      let ref = annots.get(k);
      let d = lib.context.lookup(ref);
      if (!(d instanceof PDFDict) || d.get(N('Subtype')) !== N('Widget')) continue;
      while (d.get(N('Parent')) instanceof PDFRef) { ref = d.get(N('Parent')); d = lib.context.lookup(ref); }
      roots.add(ref);
    }
  }
  for (let k = fields.size() - 1; k >= 0; k--) if (roots.has(fields.get(k))) fields.remove(k);
}

// pdf-lib writes every object it read, used or not, so the old page content
// would still be in the file. Drop whatever the document no longer reaches.
function dropUnreachable(lib) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = window.PDFLib;
  const ctx = lib.context;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o)) continue;
      seen.add(o);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v);
    else if (o instanceof PDFArray) for (let k = 0; k < o.size(); k++) stack.push(o.get(k));
    else if (o instanceof PDFStream) stack.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref)) ctx.delete(ref);
}

/* ---------- COMPARE ---------- */

// Each page's words, with where they are.
const wordCache = new WeakMap();
function docWords(doc) {
  if (!wordCache.has(doc)) wordCache.set(doc, (async () => {
    const pages = [];
    for (let i = 0; i < doc.pages; i++) {
      const t = await pageText(doc.js, i);
      const words = [...t.text.matchAll(/\S+/g)].map((m) => ({ t: m[0].normalize('NFKC'), page: i, rects: t.boxes(m.index, m.index + m[0].length) }));
      pages.push({ W: t.W, H: t.H, words });
    }
    return pages;
  })());
  return wordCache.get(doc);
}

// Myers' shortest edit script: marks which words of `a` and `b` are kept;
// the rest were removed from `a` or added in `b`. Gives up (null) past
// `limit` edits so two long, very different files can't freeze the tab.
function diff(a, b, limit = Infinity) {
  const keepA = new Uint8Array(a.length), keepB = new Uint8Array(b.length);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) { keepA[s] = keepB[s] = 1; s++; }
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; keepA[ea] = keepB[eb] = 1; }
  const n = ea - s, m = eb - s, off = n + m + 1;
  if (!n || !m) return { keepA, keepB };
  const v = new Int32Array(2 * off + 1);
  const trace = [];
  let D = -1;
  for (let d = 0; D < 0; d++) {
    if (d > limit) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[s + x] === b[s + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { D = d; break; }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  let x = n, y = m;
  for (let d = D; d > 0; d--) {
    const prev = trace[d - 1]; // diagonals -(d-1) … d-1
    const k = x - y;
    const pk = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]) ? k + 1 : k - 1;
    const px = prev[pk + d - 1], py = px - pk;
    while (x > px && y > py) { x--; y--; keepA[s + x] = keepB[s + y] = 1; }
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; keepA[s + x] = keepB[s + y] = 1; }
  return { keepA, keepB };
}

// The changes between two PDFs: runs of removed and added words in reading
// order. Each belongs to the page pair where it shows.
async function compareDocs(oldDoc, newDoc) {
  const A = await docWords(oldDoc), B = await docWords(newDoc);
  const wa = A.flatMap((p) => p.words), wb = B.flatMap((p) => p.words);
  let keep = diff(wa.map((w) => w.t), wb.map((w) => w.t), 3000);
  if (!keep) {
    // Too different to line up as one text: compare page by page instead.
    keep = { keepA: new Uint8Array(wa.length), keepB: new Uint8Array(wb.length) };
    for (let i = 0, oa = 0, ob = 0; i < Math.max(A.length, B.length); i++) {
      const pa = A[i]?.words || [], pb = B[i]?.words || [];
      const r = diff(pa.map((w) => w.t), pb.map((w) => w.t));
      keep.keepA.set(r.keepA, oa); keep.keepB.set(r.keepB, ob);
      oa += pa.length; ob += pb.length;
    }
  }
  const hunks = [];
  for (let i = 0, j = 0; i < wa.length || j < wb.length;) {
    if (i < wa.length && j < wb.length && keep.keepA[i] && keep.keepB[j]) { i++; j++; continue; }
    const removed = [], added = [];
    while (i < wa.length && !keep.keepA[i]) removed.push(wa[i++]);
    while (j < wb.length && !keep.keepB[j]) added.push(wb[j++]);
    hunks.push({ id: hunks.length, removed, added, pair: (added[0] || removed[0]).page });
  }
  const sum = (key) => hunks.reduce((t, x) => t + x[key].length, 0);
  return { A, B, hunks, words: wa.length + wb.length, removed: sum('removed'), added: sum('added') };
}

const compare = {
  id: 'compare', keywords: 'difference diff changes versions', title: 'Compare PDF', icon: 'secCompare', color: '#d97706', cat: 'security', multiple: true, action: 'Download report', wide: true, busyText: 'Making the report…',
  desc: 'See what changed between two versions of a PDF.',
  long: 'Put two versions of a document side by side. Removed words are marked red and added words green, or compare how the pages look.',
  setup(ctx) {
    const s = ctx.state = { mode: 'text', pair: 0, result: null };
    const slots = h('div', { class: 'sec-slots' });
    const view = h('div', { class: 'sec-cmp' });
    const summary = h('div', { class: 'sec-summary' });
    const changes = h('div', { class: 'sec-changes' });

    const add = async () => { ctx.items.push(...(await ctx.addMore())); refresh(); };
    ctx.onDropMore = (more) => { ctx.items.push(...more); refresh(); };
    const slot = (k) => {
      const d = ctx.items[k];
      const label = h('span', { class: 'sec-slot__label' }, h('span', { class: 'sec-dot' + (k ? ' sec-dot--add' : ' sec-dot--del') }), k ? 'New version' : 'Old version');
      if (!d) return h('div', { class: 'sec-slot sec-slot--empty' }, label, h('button', { type: 'button', class: 'btn btn--soft', onclick: add }, icon('plus'), 'Add PDF'));
      return h('div', { class: 'sec-slot' }, label, fileRow(d),
        h('button', { type: 'button', class: 'iconbtn sec-slot__x', 'aria-label': `Remove ${d.name}`, onclick: () => { ctx.items.splice(k, 1); refresh(); } }, icon('x')));
    };
    const refresh = async () => {
      if (ctx.items.length > 2) { toast('Only two PDFs can be compared, so the first two are used.'); ctx.items.splice(2); }
      const both = ctx.items.length === 2;
      ctx.action.disabled = !both;
      slots.replaceChildren(slot(0),
        h('button', { type: 'button', class: 'iconbtn sec-swap', disabled: !both, title: 'Swap old and new', 'aria-label': 'Swap old and new', onclick: () => { ctx.items.reverse(); refresh(); } }, icon('secSwap')),
        slot(1));
      s.result = null;
      if (!both) {
        view.replaceChildren(h('p', { class: 'sec-empty' }, 'Add the other version to see what changed.'));
        summary.replaceChildren(h('p', { class: 'muted small' }, 'Choose two PDFs: the old version and the new one.'));
        changes.replaceChildren();
        return;
      }
      busy('Comparing…');
      try { s.result = await compareDocs(ctx.items[0], ctx.items[1]); } finally { busy(false); }
      if (!s.result.words) s.mode = 'visual';
      s.pair = s.result.hunks[0]?.pair ?? 0;
      drawSide();
      drawView();
    };

    const drawSide = () => {
      const r = s.result;
      summary.replaceChildren(
        h('p', { class: 'sec-summary__big' }, !r.words ? 'No text to compare' : r.hunks.length ? plural(r.hunks.length, 'change') : 'No changes in the text'),
        h('p', { class: 'muted small' }, !r.words ? 'These PDFs have no text (they may be scans). Visual shows how the pages differ.'
          : r.hunks.length ? `${plural(r.removed, 'word')} removed, ${plural(r.added, 'word')} added. Tap a change to see it.`
            : 'Both versions have the same words. Use Visual to check pictures and layout.'),
        ...(r.hunks.length ? [legend('Removed', 'Added')] : []));
      changes.replaceChildren(...r.hunks.slice(0, 400).map((x) => h('button', { type: 'button', class: 'sec-change', 'data-h': x.id, onclick: () => { s.mode = 'text'; s.pair = x.pair; drawView(x.id); } },
        h('span', { class: 'sec-change__page' }, `Page ${x.pair + 1}`),
        x.removed.length > 0 && h('del', {}, clip(x.removed.map((w) => w.t).join(' '))),
        x.added.length > 0 && h('ins', {}, clip(x.added.map((w) => w.t).join(' '))))),
      ...(r.hunks.length > 400 ? [h('p', { class: 'muted small' }, `…and ${r.hunks.length - 400} more. The report lists them all.`)] : []));
    };

    const drawView = (flash) => {
      const r = s.result;
      const n = Math.max(ctx.items[0].pages, ctx.items[1].pages);
      s.pair = clamp(s.pair, 0, n - 1);
      const body = h('div', { class: 'sec-cmp__body' });
      view.replaceChildren(h('div', { class: 'sec-bar' },
        segmented([['text', 'Text'], ['visual', 'Visual']], s.mode, (v) => { s.mode = v; drawView(); }),
        h('span', { class: 'sec-bar__gap' }),
        h('button', { class: 'iconbtn', 'aria-label': 'Previous page', disabled: s.pair === 0, onclick: () => { s.pair--; drawView(); } }, icon('back')),
        h('span', { class: 'sec-bar__where' }, `Page ${s.pair + 1} of ${n}`),
        h('button', { class: 'iconbtn flip', 'aria-label': 'Next page', disabled: s.pair >= n - 1, onclick: () => { s.pair++; drawView(); } }, icon('back'))), body);
      changes.querySelectorAll('.sec-change').forEach((b) => b.classList.toggle('on', +b.dataset.h === flash));
      if (flash != null && window.matchMedia('(max-width: 960px)').matches) view.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (s.mode === 'visual') { drawVisual(body, ctx.items[0], ctx.items[1], s.pair).catch((err) => console.error(err)); return; }
      const col = (k) => {
        const d = ctx.items[k];
        const info = (k ? r.B : r.A)[s.pair];
        const head = h('p', { class: 'sec-col__head' }, h('span', { class: 'sec-dot' + (k ? ' sec-dot--add' : ' sec-dot--del') }), h('strong', {}, k ? 'New' : 'Old'), h('span', {}, d.name));
        if (!info) return h('div', { class: 'sec-col' }, head, h('div', { class: 'sec-col__none' }, `No page ${s.pair + 1}`));
        const canvas = h('canvas');
        const page = h('div', { class: 'sec-cpage', style: { aspectRatio: `${info.W} / ${info.H}` } }, canvas);
        for (const x of r.hunks) for (const w of k ? x.added : x.removed) {
          if (w.page !== s.pair) continue;
          for (const rc of w.rects) page.append(h('span', { class: 'sec-hl' + (k ? ' sec-hl--add' : '') + (x.id === flash ? ' flash' : ''), style: pct(rc, info) }));
        }
        requestAnimationFrame(() => renderPage(d.js, s.pair, 0, { canvas, scale: screenPx(page.clientWidth || 400) / info.W }).catch(() => {}));
        return h('div', { class: 'sec-col' }, head, page);
      };
      body.append(h('div', { class: 'sec-pair' }, col(0), col(1)));
    };

    ctx.main.append(slots, view);
    ctx.side.append(summary, changes);
    refresh();
  },
  async run(ctx) {
    const [oldDoc, newDoc] = ctx.items;
    const r = ctx.state.result || await compareDocs(oldDoc, newDoc);
    return {
      files: [pdfOut(`${baseName(newDoc.name)}-compared.pdf`, await report(oldDoc, newDoc, r))],
      title: 'Your report is ready',
      note: r.hunks.length ? `${plural(r.hunks.length, 'change')} found.` : 'No changes in the text were found.',
    };
  },
};

const clip = (t, n = 90) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const legend = (del, add) => h('div', { class: 'sec-legend' }, h('span', { class: 'sec-key sec-key--del' }, del), h('span', { class: 'sec-key sec-key--add' }, add));

// Pixel difference of one page pair: what is the same is faded, ink only in
// the old page is red, ink only in the new one is green.
async function drawVisual(body, a, b, i) {
  const note = h('p', { class: 'muted small' }, 'Comparing how the pages look…');
  const out = h('canvas');
  body.append(h('div', { class: 'sec-vis' }, out), legend('Only in old', 'Only in new'), note);
  const view = async (d) => (i < d.pages ? (await d.js.getPage(i + 1)).getViewport({ scale: 1 }) : null);
  const [va, vb] = await Promise.all([view(a), view(b)]);
  const W = Math.max(va?.width || 0, vb?.width || 0), H = Math.max(va?.height || 0, vb?.height || 0);
  const scale = Math.min(screenPx(body.clientWidth || 600), 1400) / W;
  const cw = Math.round(W * scale), ch = Math.round(H * scale);
  const pixels = async (d, v) => {
    const c = h('canvas', { width: cw, height: ch });
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff';
    x.fillRect(0, 0, cw, ch);
    if (v) x.drawImage(await renderPage(d.js, i, 0, { lazy: false, scale }), 0, 0);
    return x.getImageData(0, 0, cw, ch).data;
  };
  const [pa, pb] = await Promise.all([pixels(a, va), pixels(b, vb)]);
  out.width = cw; out.height = ch;
  const c = out.getContext('2d');
  const img = c.createImageData(cw, ch);
  const d = img.data;
  let changed = 0;
  for (let p = 0; p < d.length; p += 4) {
    const la = pa[p] * 0.3 + pa[p + 1] * 0.59 + pa[p + 2] * 0.11, lb = pb[p] * 0.3 + pb[p + 1] * 0.59 + pb[p + 2] * 0.11;
    if (Math.abs(pa[p] - pb[p]) + Math.abs(pa[p + 1] - pb[p + 1]) + Math.abs(pa[p + 2] - pb[p + 2]) > 90) {
      changed++;
      const added = lb < la;
      d[p] = added ? 22 : 225; d[p + 1] = added ? 163 : 29; d[p + 2] = added ? 74 : 72;
    } else d[p] = d[p + 1] = d[p + 2] = 255 - (255 - lb) * 0.3;
    d[p + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  const share = (changed / (cw * ch)) * 100;
  note.textContent = !va || !vb ? `Page ${i + 1} is only in the ${va ? 'old' : 'new'} version.`
    : changed ? `${share < 0.1 ? 'Less than 0.1' : share.toFixed(1)}% of the page looks different.` : 'These pages look the same.';
}

// The report: a summary of every change, then each page pair side by side
// on a landscape page, with the changes marked.
async function report(oldDoc, newDoc, r) {
  const out = await PDFDocument.create();
  out.setTitle(`Comparison of ${oldDoc.name} and ${newDoc.name}`);
  const pick = fontPicker(out);
  const bold = await pick('', true), reg = await pick('');
  const [PW, PH, M] = [842, 595, 36];
  const RED = rgb(0.88, 0.11, 0.28), GREEN = rgb(0.06, 0.6, 0.27), INK = rgb(0.09, 0.09, 0.23), MUTED = rgb(0.39, 0.42, 0.54), LINE = rgb(0.83, 0.85, 0.9);
  // Text that may be in any language; returns its width.
  const text = async (page, str, x, y, size, color = INK) => {
    const font = await pick(str);
    page.drawText(str, { x, y, size, font, color });
    return font.widthOfTextAtSize(str, size);
  };
  // As much of `str` as fits in `width`, ending with an ellipsis if cut.
  const fit = async (str, size, width) => {
    const font = await pick(str);
    if (font.widthOfTextAtSize(str, size) <= width) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (font.widthOfTextAtSize(str.slice(0, mid) + '…', size) <= width) lo = mid; else hi = mid - 1; }
    return str.slice(0, lo) + '…';
  };

  let page = out.addPage([PW, PH]);
  let y = PH - M - 12;
  page.drawText('Comparison report', { x: M, y, size: 22, font: bold, color: INK });
  y -= 30;
  for (const [label, d] of [['Old', oldDoc], ['New', newDoc]]) {
    page.drawText(label, { x: M, y, size: 11, font: bold, color: INK });
    await text(page, await fit(`${d.name} (${plural(d.pages, 'page')})`, 11, PW - 2 * M - 40), M + 40, y, 11);
    y -= 16;
  }
  page.drawText(`Made on ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })} with PDF Tools, on this device.`, { x: M, y, size: 9, font: reg, color: MUTED });
  y -= 32;
  page.drawText(r.hunks.length ? `${plural(r.hunks.length, 'change')}: ${plural(r.removed, 'word')} removed, ${plural(r.added, 'word')} added.`
    : r.words ? 'No changes in the text.' : 'These PDFs have no text to compare.', { x: M, y, size: 14, font: bold, color: INK });
  y -= 24;
  if (r.hunks.length) {
    for (const [c, label] of [[RED, 'Removed (only in the old version)'], [GREEN, 'Added (only in the new version)']]) {
      page.drawRectangle({ x: M, y: y - 1, width: 18, height: 9, color: c, opacity: 0.28, borderColor: c, borderWidth: 0.8 });
      page.drawText(label, { x: M + 26, y, size: 9, font: reg, color: MUTED });
      y -= 15;
    }
    y -= 10;
  }
  for (const x of r.hunks) {
    const lines = [];
    if (x.removed.length) lines.push(['-', RED, x.removed.map((w) => w.t).join(' ')]);
    if (x.added.length) lines.push(['+', GREEN, x.added.map((w) => w.t).join(' ')]);
    if (y - lines.length * 14 < M) { page = out.addPage([PW, PH]); y = PH - M - 12; }
    page.drawText(`Page ${x.pair + 1}`, { x: M, y, size: 9, font: bold, color: MUTED });
    for (const [sign, c, str] of lines) {
      page.drawText(sign, { x: M + 54, y, size: 10, font: bold, color: c });
      await text(page, await fit(str, 10, PW - 2 * M - 68), M + 68, y, 10, c);
      y -= 14;
    }
    y -= 4;
  }

  const [libA, libB] = await Promise.all([loadLib(oldDoc), loadLib(newDoc)]);
  const n = Math.max(oldDoc.pages, newDoc.pages);
  const slotW = (PW - 3 * M) / 2, slotH = PH - 2 * M - 30;
  for (let i = 0; i < n; i++) {
    busy(`Making the report: page ${i + 1} of ${n}…`);
    await tick();
    const pg = out.addPage([PW, PH]);
    const count = r.hunks.filter((x) => x.pair === i).length;
    pg.drawText(`Page ${i + 1}`, { x: M, y: PH - M - 6, size: 13, font: bold, color: INK });
    pg.drawText(count ? plural(count, 'change') : 'No changes in the text', { x: M + 64, y: PH - M - 6, size: 10, font: reg, color: count ? RED : MUTED });
    for (const [k, lib, info] of [[0, libA, r.A[i]], [1, libB, r.B[i]]]) {
      const X0 = M + k * (slotW + M);
      await text(pg, await fit(`${k ? 'New' : 'Old'}: ${(k ? newDoc : oldDoc).name}`, 8, slotW), X0, PH - M - 24, 8, MUTED);
      if (!info) {
        pg.drawRectangle({ x: X0, y: M, width: slotW, height: slotH, borderColor: LINE, borderWidth: 1, borderDashArray: [4, 3] });
        pg.drawText(`No page ${i + 1}`, { x: X0 + slotW / 2 - 28, y: M + slotH / 2, size: 11, font: reg, color: MUTED });
        continue;
      }
      const src = lib.getPage(i);
      const f = pageFrame(src);
      const cb = src.getCropBox();
      const emb = await out.embedPage(src, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
      const sc = Math.min(slotW / f.W, slotH / f.H);
      const w = cb.width * sc, hh = cb.height * sc;
      const Y0 = M + slotH - f.H * sc; // top of the slot
      // Embedded pages ignore /Rotate: turn it clockwise as a reader would.
      const at = f.R === 90 ? [X0, Y0 + w] : f.R === 180 ? [X0 + w, Y0 + hh] : f.R === 270 ? [X0 + hh, Y0] : [X0, Y0];
      pg.drawPage(emb, { x: at[0], y: at[1], xScale: sc, yScale: sc, rotate: degrees(-f.R) });
      pg.drawRectangle({ x: X0, y: Y0, width: f.W * sc, height: f.H * sc, borderColor: LINE, borderWidth: 0.6 });
      const c = k ? GREEN : RED;
      for (const x of r.hunks) for (const wd of k ? x.added : x.removed) {
        if (wd.page !== i) continue;
        for (const rc of wd.rects) pg.drawRectangle({ x: X0 + rc.x * sc, y: Y0 + (f.H - rc.y - rc.h) * sc, width: rc.w * sc, height: rc.h * sc, color: c, opacity: 0.28, borderColor: c, borderWidth: 0.5 });
      }
    }
  }
  return out.save();
}

export const SECURITY_MORE = [ocr, redact, compare];
