// Word, PowerPoint, Excel and HTML to PDF, all on this device.
// The browser lays each document out in a hidden frame, page breaks are put
// between lines of text (never through them), html2canvas draws each page,
// and the words go on top as invisible text so the PDF can still be searched,
// selected and copied.
import { h, icon, registerIcons, busy, toast, loadScript, modal, sortable, uid, fmtSize, baseName, fontCanDraw, PDFDocument, StandardFonts } from '../core.js';
import { field, segmented, check, pdfOut } from '../ui.js';

registerIcons({
  tpWord: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m8.5 12 1.5 6 2-4 2 4 1.5-6"/>',
  tpSlides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v5"/><path d="M8 21h8"/><path d="M8 12V9"/><path d="M12 12V8"/><path d="M16 12v-2"/>',
  tpSheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/>',
  tpHtml: '<path d="m8 8-5 4 5 4"/><path d="m16 8 5 4-5 4"/><path d="m14 4-4 16"/>',
  tpLink: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  tpPaste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
});

/* ---------- shared: frame, paging, drawing, text layer ---------- */

const PX = 0.75; // CSS px -> PDF points
const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
const SCALE = 2; // image pixels per CSS px of the page: sharp in print and when zoomed
const STRIP = 1800; // tallest piece drawn at once, so canvases stay within phone limits
const MAX_PAGE = 14400; // the largest page PDF readers accept (200 inches)
const MAX_SIDE = 4000; // widest or tallest canvas drawn at once (phones refuse ~16M pixels)
const LOAD_WAIT = 10000; // longest wait for a frame, its pictures or its fonts

// Nothing in a layout frame may reach the network: a document must not be
// able to ping a tracker (or hold up the conversion) with a picture, a style
// sheet or a font. Its own pictures and fonts come as data: or blob: URLs.
// `origin` lets a page fetched by web address load its own pictures and styles.
const cspFor = (origin = '') => `default-src 'none'; img-src data: blob: ${origin}; style-src 'unsafe-inline' data: ${origin}; font-src data: blob: ${origin}; media-src data: blob:`.replace(/ +;/g, ';');
const timeout = (p, ms = LOAD_WAIT) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

// Hidden frames scroll; their scrollbars must not take width or get drawn.
const NO_BARS = 'html { scrollbar-width: none; } html::-webkit-scrollbar { display: none; }';

const lib = (name) => loadScript({
  canvas: 'vendor/html2canvas/html2canvas.min.js',
  docx: 'vendor/docx-preview/docx-preview.min.js',
  xlsx: 'vendor/sheetjs/xlsx.full.min.js',
}[name]);

// A hidden frame to lay a document out in, away from the app's own styles.
// Sandboxed without allow-scripts: nothing inside it can run.
async function frame(width, height, html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${cspFor()}"><style>${NO_BARS}</style></head><body></body></html>`) {
  const el = h('iframe', { class: 'tp-frame', sandbox: 'allow-same-origin', 'aria-hidden': 'true', tabindex: '-1', style: { width: width + 'px', height: height + 'px' } });
  const loaded = new Promise((r) => el.addEventListener('load', r, { once: true }));
  el.srcdoc = html;
  document.body.append(el);
  // A picture or style sheet that never answers would hold up `load` forever.
  await timeout(loaded);
  return el;
}

// Waits for fonts and pictures so measurements and drawings match.
async function settle(doc) {
  await Promise.all([...doc.images].map((im) => (im.complete ? null : new Promise((r) => { im.addEventListener('load', r); im.addEventListener('error', r); setTimeout(r, 8000); }))));
  // Give up on pictures still loading: html2canvas waits for every picture of
  // its copy of the page with no time limit, so one that never answers would
  // stop the conversion. They are then counted as pictures that couldn't load.
  for (const im of doc.images) {
    if (im.complete) continue;
    im.removeAttribute('srcset');
    im.closest('picture')?.querySelectorAll('source').forEach((s) => s.remove());
    im.src = 'data:,';
  }
  if (doc.fonts) await timeout(doc.fonts.ready);
}

// Points every url() and @import in the frame's styles that leads outside the
// file at nothing. The frame's policy already blocks them, but html2canvas
// loads background pictures again from the app's own window.
function localOnly(doc) {
  const fix = (t) => t.replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => (/^(data|blob):|^#/i.test(u.trim()) ? m : 'url("data:,")'));
  for (const st of doc.querySelectorAll('style')) if (/url\(|@import/i.test(st.textContent)) st.textContent = fix(st.textContent);
  for (const el of doc.querySelectorAll('[style*="url("]')) el.setAttribute('style', fix(el.getAttribute('style')));
}

// Draws part of `el` (x, y relative to its top-left, in CSS px) to a canvas.
async function shoot(el, x, y, w, hgt, scale) {
  const doc = el.ownerDocument;
  // A canvas from the frame's own document, so fonts the file brings along are used.
  const canvas = doc.createElement('canvas');
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(hgt * scale);
  const win = doc.defaultView;
  await window.html2canvas(el, {
    canvas, x, y, width: w, height: hgt, scale, logging: false, useCORS: true, imageTimeout: 8000,
    backgroundColor: '#ffffff', windowWidth: win.innerWidth, windowHeight: win.innerHeight, scrollX: 0, scrollY: 0,
  });
  return canvas;
}

async function jpeg(canvas) {
  // The canvas is rounded up to whole pixels; the sliver html2canvas leaves
  // transparent would turn dark in a JPEG.
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('This page is too large to draw on this device. Try fewer columns or a smaller page.');
  return new Uint8Array(await blob.arrayBuffer());
}

// Draws rows [y0, y1) of `el` onto `page`, its top-left at (left, top) points,
// k points per CSS px. Tall areas go in strips; no canvas side passes MAX_SIDE.
async function paint(pdf, page, el, { x0 = 0, y0, y1, w, left, top, k, scale = SCALE }) {
  const sc = Math.min(scale, MAX_SIDE / w);
  const strip = Math.max(1, Math.min(STRIP, Math.floor(MAX_SIDE / sc)));
  for (let y = y0; y < y1; y += strip) {
    const hh = Math.min(strip, y1 - y);
    const img = await pdf.embedJpg(await jpeg(await shoot(el, x0, y, w, hh, sc)));
    page.drawImage(img, { x: left, y: page.getHeight() - top - (y - y0 + hh) * k, width: w * k, height: hh * k });
  }
}

// Every word under root with its box (frame px). keep(x, y) drops words
// whose middle is outside the part being drawn.
function wordsIn(root, keep = () => true) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  const out = [];
  // Per element: whether it is see-through, and the box its overflow clips it to.
  const seen = new Map();
  const look = (el) => {
    if (seen.has(el)) return seen.get(el);
    const up = el === root || !el.parentElement ? { gone: false, clip: null } : look(el.parentElement);
    const cs = win.getComputedStyle(el);
    let clip = up.clip;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      clip = clip ? { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    const v = { gone: up.gone || parseFloat(cs.opacity) === 0, clip };
    seen.set(el, v);
    return v;
  };
  for (let n; (n = walk.nextNode());) {
    const s = n.nodeValue;
    if (!s.trim() || !n.parentElement) continue;
    const cs = win.getComputedStyle(n.parentElement);
    if (cs.visibility !== 'visible' || cs.display === 'none') continue;
    // Text that can't be seen on the page (see-through, or cut off by its box)
    // stays out of the text layer too.
    const { gone, clip } = look(n.parentElement);
    if (gone) continue;
    const size = parseFloat(cs.fontSize);
    for (const m of s.matchAll(/\S+/g)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      const mx = r.left + r.width / 2, my = r.top + r.height / 2;
      if (r.width < 0.5 || r.height < 0.5 || !keep(mx, my)) continue;
      if (clip && (mx < clip.left || mx > clip.right || my < clip.top || my > clip.bottom)) continue;
      out.push({ text: m[0], x: r.left, y: r.top, w: r.width, h: r.height, size });
    }
  }
  return out;
}

// The words as invisible text. at.map(x, y) turns frame px into page points
// from the top-left; at.k is points per px.
function addWords(page, font, words, at) {
  const L = window.PDFLib;
  const key = page.node.newFontDictionary(font.name, font.ref);
  const H = page.getHeight();
  const ops = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
  for (const w of words) {
    // Helvetica only covers Western letters; other scripts stay picture only.
    if (!fontCanDraw(font, w.text)) continue;
    const size = Math.min(w.size, w.h) * at.k;
    const width = font.widthOfTextAtSize(w.text, size);
    if (!(size > 0.5 && width > 0)) continue;
    const [x, y] = at.map(w.x, w.y + w.h * 0.8);
    // Stretch each word to its width on the picture, so selections line up.
    ops.push(L.setFontAndSize(key, size), L.setCharacterSqueeze(Math.min(400, (w.w * at.k / width) * 100)),
      L.setTextMatrix(1, 0, 0, 1, x, H - y), L.showText(font.encodeText(w.text + ' ')));
  }
  ops.push(L.endText(), L.popGraphicsState());
  // In batches: a big sheet has more words than a call can take arguments.
  for (let i = 0; i < ops.length; i += 4000) page.pushOperators(...ops.slice(i, i + 4000));
}

// Things a page break should not cut through: lines of text, pictures and
// table rows, as [top, bottom] from `origin` (frame px).
function solids(root, origin) {
  const doc = root.ownerDocument;
  const range = doc.createRange();
  const out = [];
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    if (!n.nodeValue.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.height > 0) out.push([r.top - origin, r.bottom - origin]);
  }
  for (const el of root.querySelectorAll('img, svg, canvas, video, tr')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0) out.push([r.top - origin, r.bottom - origin]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Breaks the author asked for (CSS break-before, page-break-after…).
function forcedBreaks(root, origin) {
  const win = root.ownerDocument.defaultView;
  const out = [];
  // Exact values only: "avoid-page" asks for no break.
  const forced = (v) => /^(page|always|left|right|recto|verso)$/.test(v);
  for (const el of root.querySelectorAll('*')) {
    const cs = win.getComputedStyle(el);
    if (forced(cs.breakBefore) || forced(cs.pageBreakBefore)) out.push(el.getBoundingClientRect().top - origin);
    if (forced(cs.breakAfter) || forced(cs.pageBreakAfter)) out.push(el.getBoundingClientRect().bottom - origin);
  }
  return out.filter((y) => y > 1).sort((a, b) => a - b);
}

// Splits [0, total) into pages at most `avail` tall, moving each break up to
// just above anything it would cut. Returns [[y0, y1], …].
function breaks(total, avail, boxes, forced = []) {
  const out = [];
  let y = 0;
  while (y < total - 1) {
    let end = Math.min(y + avail, total);
    const f = forced.find((b) => b > y + 1 && b < end - 1);
    if (f) end = f;
    else if (end < total) {
      for (let moved = true; moved;) {
        moved = false;
        for (const [t, b] of boxes) {
          if (t >= end) break;
          if (b > end + 0.5 && t > y + 0.5 && b - t < avail) { end = t; moved = true; }
        }
      }
      // Nothing sensible to break at (one huge picture or table row): cut
      // near the full height, but still between lines of text.
      if (end - y < avail * 0.2) {
        end = Math.min(y + avail, total);
        for (let moved = true; moved;) {
          moved = false;
          for (const [t, b] of boxes) {
            if (t >= end) break;
            if (b > end + 0.5 && t > y + 0.5 && b - t < avail * 0.2) { end = t; moved = true; }
          }
        }
      }
    }
    out.push([y, end]);
    y = end;
  }
  return out.length ? out : [[0, Math.max(1, total)]];
}

// Office files name fonts the reader may not have (Calibri on a phone);
// fall back to the closest common ones.
function fontStack(name) {
  const q = name ? `"${name.replace(/["']/g, '')}", ` : '';
  if (/courier|consolas|mono|menlo/i.test(name)) return `${q}Consolas, "Courier New", monospace`;
  if (/times|cambria|georgia|garamond|antiqua|palatino|constantia|baskerville|minion|bookman/i.test(name)) return `${q}Cambria, Georgia, "Times New Roman", serif`;
  return `${q}Calibri, Carlito, Arial, Helvetica, sans-serif`;
}

function pageSize(s, landscape) {
  const [w, hh] = SIZES[s.size] || SIZES.a4;
  const land = s.orient === 'landscape' || (s.orient === 'auto' && landscape);
  return land ? [hh, w] : [w, hh];
}

/* ---------- shared: UI ---------- */

const orientField = (s, auto = true) => field('Orientation', segmented([...(auto ? [['auto', 'Auto']] : []), ['portrait', 'Portrait'], ['landscape', 'Landscape']], s.orient, (v) => (s.orient = v)));
const marginField = (s) => field('Margins', segmented([[0, 'None'], [28, 'Small'], [54, 'Normal']], s.margin, (v) => (s.margin = v)));

// Reorderable cards for the files a tool takes, with the file type in place of a thumbnail.
function fileCards(ctx, { ext, color, label, bad, onChange }) {
  const list = h('div', { class: 'cards' });
  const draw = () => {
    list.replaceChildren(...ctx.items.map((it) => {
      it.uid ||= uid();
      const why = bad?.(it);
      return h('div', { class: 'card', 'data-id': it.uid },
        h('div', { class: 'card__page' }, h('span', { class: 'tp-doc', style: { '--tp': color } }, (it.name.match(/\.(\w+)$/)?.[1] || ext).toUpperCase())),
        h('div', { class: 'card__meta' }, h('strong', { title: it.name }, it.name), h('span', { class: why ? 'bad' : '' }, why || fmtSize(it.size || 0))),
        h('button', { class: 'iconbtn card__x', 'aria-label': `Remove ${it.name}`, onclick: () => { ctx.items.splice(ctx.items.indexOf(it), 1); draw(); } }, icon('x')),
        h('span', { class: 'grip', title: 'Drag to reorder' }, icon('grip')));
    }), h('button', { class: 'card card--add', onclick: add }, icon('plus'), `Add ${label}`));
    onChange?.();
  };
  const add = async () => { ctx.items.push(...(await ctx.addMore())); draw(); };
  ctx.onDropMore = (more) => { ctx.items.push(...more); draw(); };
  sortable(list, (ids) => ctx.items.sort((a, b) => ids.indexOf(a.uid) - ids.indexOf(b.uid)));
  draw();
  return list;
}

// Runs convert(item, pdf, font, progress) for each file, into one PDF or one each.
async function convertAll(items, oneFile, mergedName, convert) {
  const files = [];
  const notes = [];
  let pdf = null;
  let font;
  for (const [i, it] of items.entries()) {
    if (!pdf) { pdf = await PDFDocument.create(); font = await pdf.embedFont(StandardFonts.Helvetica); }
    const tag = items.length > 1 ? `File ${i + 1} of ${items.length}, ` : '';
    busy(`${tag}reading…`);
    const note = await convert(it, pdf, font, (n, total) => busy(`${tag}page ${n}${total ? ` of ${total}` : ''}…`));
    if (note) notes.push(items.length > 1 ? `${it.name}: ${note}` : note);
    if (!oneFile) { files.push(pdfOut(`${baseName(it.name)}.pdf`, await pdf.save())); pdf = null; }
  }
  if (oneFile) files.push(pdfOut(items.length === 1 ? `${baseName(items[0].name)}.pdf` : mergedName, await pdf.save()));
  return { files, notes };
}

/* ---------- Word ---------- */

const PAGE_NO = '', PAGE_COUNT = '';

// Page numbers in headers and footers are fields whose saved value is stale,
// and docx-preview leaves fields out. Swap them for markers we fill per page.
async function markPageFields(file) {
  const zip = await window.JSZip.loadAsync(file);
  let changed = false;
  const mark = (instr) => (/^\s*NUMPAGES\b/.test(instr) ? PAGE_COUNT : /^\s*PAGE\b/.test(instr) ? PAGE_NO : null);
  for (const part of zip.file(/^word\/(header|footer)\d*\.xml$/)) {
    let x = await part.async('text');
    const before = x;
    x = x.replace(/<w:fldSimple\b[^>]*w:instr="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/w:fldSimple>)/g, (m, instr) => {
      const k = mark(instr);
      return k ? `<w:r><w:t>${k}</w:t></w:r>` : m;
    });
    // From inside the run that begins the field to inside the run that ends it,
    // so what is left is one well-formed run holding the marker.
    x = x.replace(/<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>((?:(?!w:fldCharType="begin")[\s\S])*?)<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>/g, (m, inner) => {
      const k = mark([...inner.matchAll(/<w:instrText[^>]*>([^<]*)</g)].map((t) => t[1]).join(''));
      return k ? `<w:t>${k}</w:t>` : m;
    });
    if (x !== before) { zip.file(part.name, x); changed = true; }
  }
  return changed ? zip.generateAsync({ type: 'arraybuffer' }) : file;
}

const WORD_CSS = NO_BARS + `
body { margin: 0; background: #fff; }
section.docx { margin: 0 0 24px; box-shadow: none; }
.tp-view { flex: none; position: relative; overflow: hidden; margin-bottom: auto; }
.tp-flow { position: relative; }`;

async function wordToPdf(item, pdf, font, progress, s) {
  await Promise.all([lib('canvas'), lib('docx')]);
  const unreadable = () => new Error(`“${item.name}” could not be read as a Word file.`);
  let data;
  try { data = await markPageFields(item.file); } catch (err) { console.error(err); throw unreadable(); }
  const fr = await frame(1200, 1200);
  try {
    const doc = fr.contentDocument;
    try {
      await window.docx.renderAsync(data, doc.body, doc.head, {
        className: 'docx', inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, experimental: true,
        useBase64URL: true, renderComments: false, renderChanges: false,
      });
    } catch (err) {
      console.error(err);
      throw unreadable();
    }
    if (!doc.querySelector('section.docx')) throw unreadable();
    // After rendering: docx-preview empties the style container first.
    doc.head.append(Object.assign(doc.createElement('style'), { textContent: WORD_CSS }));
    for (const st of doc.querySelectorAll('style')) st.textContent = st.textContent.replace(/font-family:\s*([^;}]+)/g, (m, fam) => (/(serif|monospace)\s*$/.test(fam) ? m : `font-family: ${fontStack(fam.split(',')[0].trim().replace(/['"]/g, ''))}`));
    for (const el of doc.body.querySelectorAll('[style*="font-family"]')) el.style.fontFamily = fontStack(el.style.fontFamily.split(',')[0].replace(/['"]/g, '').trim());
    localOnly(doc);
    await settle(doc);

    // Each docx-preview section is one or more pages. Put its body in a window
    // (view) we can scroll page by page, between the header and footer.
    const plan = [];
    for (const sec of doc.querySelectorAll('section.docx')) {
      const header = sec.querySelector(':scope > header');
      const footer = sec.querySelector(':scope > footer');
      const view = doc.createElement('div');
      const flow = doc.createElement('div');
      view.className = 'tp-view';
      flow.className = 'tp-flow';
      view.append(flow);
      const body = [...sec.children].filter((c) => c !== header && c !== footer);
      sec.insertBefore(view, body[0] || footer);
      flow.append(...body);
      const W = sec.getBoundingClientRect().width;
      const H = parseFloat(doc.defaultView.getComputedStyle(sec).minHeight) || sec.offsetHeight;
      sec.style.height = H + 'px';
      view.style.height = '0px';
      const cs = doc.defaultView.getComputedStyle(sec);
      const limit = footer ? footer.getBoundingClientRect().top : sec.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom);
      const avail = Math.max(40, limit - view.getBoundingClientRect().top);
      view.style.height = 'auto';
      const top = flow.getBoundingClientRect().top;
      const pages = breaks(flow.scrollHeight, avail, solids(flow, top));
      plan.push({ sec, view, flow, header, footer, W, H, pages });
    }
    const fields = [];
    const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) if (/[]/.test(n.nodeValue)) fields.push([n, n.nodeValue]);

    const total = plan.reduce((t, p) => t + p.pages.length, 0);
    let n = 0;
    for (const p of plan) {
      for (const [y0, y1] of p.pages) {
        progress(++n, total);
        for (const [node, tpl] of fields) node.nodeValue = tpl.replaceAll(PAGE_NO, n).replaceAll(PAGE_COUNT, total);
        p.view.style.height = (y1 - y0) + 'px';
        p.flow.style.top = -y0 + 'px';
        const [PW, PH] = s.size === 'doc' ? [p.W * PX, p.H * PX] : pageSize(s, p.W > p.H);
        const k = Math.min(PW / p.W, PH / p.H);
        const left = (PW - p.W * k) / 2, top = (PH - p.H * k) / 2;
        const page = pdf.addPage([PW, PH]);
        await paint(pdf, page, p.sec, { y0: 0, y1: p.H, w: p.W, left, top, k });
        const r = p.sec.getBoundingClientRect();
        const clips = [p.view, p.header, p.footer].filter(Boolean).map((el) => el.getBoundingClientRect());
        const inside = (x, y) => clips.some((c) => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom);
        addWords(page, font, wordsIn(p.sec, inside), { k, map: (x, y) => [left + (x - r.left) * k, top + (y - r.top) * k] });
      }
    }
    return null;
  } finally {
    fr.remove();
  }
}

const isOld = (it) => /\.(doc|ppt)$/i.test(it.name);
const oldNote = (it) => (isOld(it) ? 'Old format: save it as .' + (/\.doc$/i.test(it.name) ? 'docx' : 'pptx') + ' first' : '');

const wordToPdfTool = {
  id: 'word-to-pdf', keywords: 'docx doc word office convert document', title: 'Word to PDF', icon: 'tpWord', color: '#2563eb', cat: 'convert',
  accept: { accept: '.docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword', test: (f) => /\.docx?$/i.test(f.name), label: 'Word files' },
  multiple: true, action: 'Convert to PDF', busyText: 'Converting…',
  desc: 'Turn Word documents into PDF.',
  long: 'Turn .docx files into PDF, with their page size, margins, headers, footers, tables and pictures. Pages are drawn as sharp pictures with the words hidden behind them, so you can still search and copy the text. Fonts you don’t have are swapped for similar ones.',
  setup(ctx) {
    const s = ctx.state = { size: 'doc', orient: 'auto', oneFile: false };
    const warn = h('p', { class: 'small bad', hidden: true });
    const one = h('div', {}, check('Put all files in one PDF', s.oneFile, (v) => (s.oneFile = v)));
    const orient = orientField(s);
    const sync = () => {
      const old = ctx.items.filter(isOld);
      warn.hidden = !old.length;
      warn.textContent = old.length ? `Browsers can’t read old .doc files. Open ${old.length > 1 ? 'them' : 'it'} in Word, LibreOffice or Google Docs, choose Save as › Word Document (.docx), and add the new file.` : '';
      one.hidden = ctx.items.length < 2;
      orient.hidden = s.size === 'doc';
      ctx.action.disabled = !ctx.items.some((it) => !isOld(it));
    };
    ctx.main.append(fileCards(ctx, { ext: 'docx', color: '#2563eb', label: 'Word file', bad: oldNote, onChange: sync }));
    ctx.side.append(
      field('Page size', segmented([['doc', 'As in file'], ['a4', 'A4'], ['letter', 'Letter']], s.size, (v) => { s.size = v; sync(); })),
      orient,
      h('p', { class: 'muted small' }, 'Margins, headers and footers come from the document.'),
      one, warn);
    sync();
  },
  async run(ctx) {
    const items = ctx.items.filter((it) => !isOld(it));
    const { files } = await convertAll(items, ctx.state.oneFile, 'documents.pdf', (it, pdf, font, progress) => wordToPdf(it, pdf, font, progress, ctx.state));
    const skipped = ctx.items.length - items.length;
    return { files, zipName: 'word-pdf.zip', title: files.length > 1 ? `${files.length} PDFs are ready` : 'Your PDF is ready', note: skipped ? `${skipped} old .doc file${skipped > 1 ? 's were' : ' was'} left out. Save ${skipped > 1 ? 'them' : 'it'} as .docx to convert.` : '' };
  },
};

/* ---------- PowerPoint ---------- */

// No browser library draws .pptx well (and the usable ones aren't open), so
// this reads the slide XML and builds each slide as HTML: backgrounds,
// pictures, shapes, text with its inherited styles, tables and SmartArt.
const EMU = 9525; // per CSS px
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = (el, name) => el?.getAttribute(name) ?? null;
const kids = (el, name) => (el ? [...el.children].filter((k) => k.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((k) => k.localName === name) || null : null);
const dig = (el, ...names) => names.reduce((e, n) => kid(e, n), el);
const num = (v, d = 0) => (v == null || v === '' ? d : +v);
const rid = (el, name = 'embed') => el?.getAttributeNS(R_NS, name) || null;

function joinPath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = [];
  for (const p of (dir + target).split('/')) p === '..' ? out.pop() : p !== '.' && out.push(p);
  return out.join('/');
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' };

async function openDeck(file) {
  let zip;
  try { zip = await window.JSZip.loadAsync(file); } catch { throw new Error(`“${file.name}” is not a PowerPoint file.`); }
  const parsed = new Map();
  const xml = (path) => {
    if (!path) return null;
    if (!parsed.has(path)) parsed.set(path, (async () => { const f = zip.file(path); return f ? new DOMParser().parseFromString(await f.async('text'), 'application/xml').documentElement : null; })());
    return parsed.get(path);
  };
  const rels = async (path) => {
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    const map = {};
    for (const r of kids(await xml(`${dir}_rels/${path.slice(dir.length)}.rels`), 'Relationship')) {
      map[A(r, 'Id')] = { type: A(r, 'Type').split('/').pop(), path: A(r, 'TargetMode') === 'External' ? null : joinPath(dir, A(r, 'Target')) };
    }
    return map;
  };
  const media = new Map();
  // Pictures as data URLs; formats browsers can't show (EMF, WMF, TIFF) give null.
  const image = (path) => {
    if (!media.has(path)) {
      const type = MIME[(path || '').split('.').pop().toLowerCase()];
      const f = path && type && zip.file(path);
      media.set(path, f ? f.async('base64').then((b) => `data:${type};base64,${b}`) : Promise.resolve(null));
    }
    return media.get(path);
  };
  const pres = await xml('ppt/presentation.xml');
  if (!pres) throw new Error(`“${file.name}” is not a PowerPoint file.`);
  const presRels = await rels('ppt/presentation.xml');
  const sz = kid(pres, 'sldSz');
  return {
    xml, rels, image,
    W: num(A(sz, 'cx'), 9144000) / EMU,
    H: num(A(sz, 'cy'), 6858000) / EMU,
    slides: kids(kid(pres, 'sldIdLst'), 'sldId').map((s) => presRels[rid(s, 'id')]?.path).filter(Boolean),
    defaults: kid(pres, 'defaultTextStyle'),
    tableStyles: await xml('ppt/tableStyles.xml'),
    themes: new Map(),
    has: (path) => !!(path && zip.file(path)),
    // Pictures left out, each counted once (a master's logo shows on every slide).
    missing: { charts: 0, odd: new Set(), gone: new Set() },
  };
}

function themeOf(theme, master) {
  const els = kid(theme, 'themeElements');
  const scheme = {};
  for (const c of kid(els, 'clrScheme')?.children || []) {
    const v = c.firstElementChild;
    scheme[c.localName] = hex(A(v, 'lastClr') || A(v, 'val') || '000000');
  }
  const map = {};
  for (const a of kid(master, 'clrMap')?.attributes || []) map[a.name] = a.value;
  const font = (n) => A(dig(els, 'fontScheme', n, 'latin'), 'typeface');
  const fmt = kid(els, 'fmtScheme');
  const list = (n) => [...(kid(fmt, n)?.children || [])];
  return { scheme, map, major: font('majorFont'), minor: font('minorFont'), fills: list('fillStyleLst'), lines: list('lnStyleLst'), bgFills: list('bgFillStyleLst') };
}

/* colors are [r, g, b, a] */

const hex = (v) => { const n = parseInt(String(v).slice(-6), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; };
const rgba = (c) => (c ? `rgba(${c.slice(0, 3).map(Math.round).join(',')},${+c[3].toFixed(3)})` : 'transparent');
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500' };

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh / 6, s, l];
}
function fromHsl([hh, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)];
}

// A DrawingML color element (srgbClr, schemeClr…) with its changes applied.
// ph is the color a theme style is used with ("phClr").
function colorOf(el, th, ph) {
  if (!el) return null;
  let c;
  const v = A(el, 'val');
  switch (el.localName) {
    case 'srgbClr': c = hex(v); break;
    case 'sysClr': c = hex(A(el, 'lastClr') || (v === 'window' ? 'FFFFFF' : '000000')); break;
    case 'prstClr': c = hex(PRESET[v] || '000000'); break;
    case 'scrgbClr': c = ['r', 'g', 'b'].map((k) => Math.min(255, num(A(el, k)) / 100000 * 255)).concat(1); break;
    case 'schemeClr': {
      if (v === 'phClr') { if (!ph) return null; c = [...ph]; break; }
      const name = th.map[v] || { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[v] || v;
      c = [...(th.scheme[name] || [0, 0, 0, 1])];
      break;
    }
    default: return null;
  }
  for (const m of el.children) {
    const x = num(A(m, 'val')) / 100000;
    const hsl = () => toHsl(c);
    switch (m.localName) {
      case 'alpha': c[3] = x; break;
      case 'lumMod': { const q = hsl(); q[2] *= x; c = [...fromHsl(q), c[3]]; break; }
      case 'lumOff': { const q = hsl(); q[2] = Math.min(1, q[2] + x); c = [...fromHsl(q), c[3]]; break; }
      case 'satMod': { const q = hsl(); q[1] = Math.min(1, q[1] * x); c = [...fromHsl(q), c[3]]; break; }
      case 'tint': c = [...c.slice(0, 3).map((k) => k + (255 - k) * (1 - x)), c[3]]; break;
      case 'shade': c = [...c.slice(0, 3).map((k) => k * x), c[3]]; break;
    }
  }
  return c;
}
const colorIn = (el, th, ph) => colorOf([...(el?.children || [])].find((k) => /Clr$/.test(k.localName)), th, ph);

// One fill element -> { none } | { color } | { stops, angle, radial } | { blip }.
function fillFrom(f, th, ph) {
  switch (f?.localName) {
    case 'noFill': return { none: true };
    case 'solidFill': return { color: colorIn(f, th, ph) };
    case 'gradFill': {
      const stops = kids(kid(f, 'gsLst'), 'gs').map((g) => ({ pos: num(A(g, 'pos')) / 1000, color: colorIn(g, th, ph) })).sort((a, b) => a.pos - b.pos);
      return stops.length ? { stops, angle: num(A(kid(f, 'lin'), 'ang')) / 60000, radial: !!kid(f, 'path') } : null;
    }
    case 'blipFill': return { blip: kid(f, 'blip'), tile: !!kid(f, 'tile') };
    case 'pattFill': return { color: colorIn(kid(f, 'fgClr'), th, ph) };
    default: return null;
  }
}
const FILLS = /^(noFill|solidFill|gradFill|blipFill|pattFill)$/;
const fillOf = (el, th, ph) => fillFrom([...(el?.children || [])].find((k) => FILLS.test(k.localName)), th, ph);

// A theme style a shape points at (p:style fillRef / lnRef).
function styleRef(ref, list, th) {
  const idx = num(A(ref, 'idx'));
  if (!ref || !idx) return null;
  return { el: idx >= 1000 ? th.bgFills[idx - 1001] : list[idx - 1], ph: colorIn(ref, th) };
}

function lineOf(spPr, style, th) {
  const ln = kid(spPr, 'ln');
  const ref = styleRef(kid(style, 'lnRef'), th.lines, th);
  const fill = fillOf(ln, th) || (ref && fillOf(ref.el, th, ref.ph));
  if (!fill || fill.none || !fill.color) return null;
  const w = num(A(ln, 'w') ?? A(ref?.el, 'w'), 9525) / EMU;
  const dash = A(kid(ln, 'prstDash') || kid(ref?.el, 'prstDash'), 'val');
  const end = (n) => { const t = A(kid(ln, n), 'type'); return t && t !== 'none'; };
  return { color: fill.color, w: Math.max(w, 0.5), dash: dash && dash !== 'solid' ? (/dot/i.test(dash) ? `${w} ${w * 2}` : `${w * 4} ${w * 3}`) : null, head: end('headEnd'), tail: end('tailEnd') };
}

/* geometry: preset shapes and custom paths as SVG path data */

function presetPath(geom, w, hh) {
  const prst = A(geom, 'prst');
  const adj = (name, d) => { const g = kids(kid(geom, 'avLst'), 'gd').find((x) => A(x, 'name') === name); return (g ? +A(g, 'fmla').split(' ')[1] : d) / 100000; };
  const ss = Math.min(w, hh);
  const poly = (...pts) => 'M' + pts.map((p) => p.join(' ')).join('L') + 'Z';
  switch (prst) {
    case 'roundRect': case 'flowChartAlternateProcess': {
      const r = ss * adj('adj', 16667);
      return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${hh - r}A${r} ${r} 0 0 1 ${w - r} ${hh}H${r}A${r} ${r} 0 0 1 0 ${hh - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
    }
    case 'flowChartTerminator': { const r = Math.min(hh / 2, w / 2); return `M${r} 0H${w - r}A${r} ${hh / 2} 0 0 1 ${w - r} ${hh}H${r}A${r} ${hh / 2} 0 0 1 ${r} 0Z`; }
    case 'ellipse': case 'flowChartConnector': return `M0 ${hh / 2}A${w / 2} ${hh / 2} 0 1 1 ${w} ${hh / 2}A${w / 2} ${hh / 2} 0 1 1 0 ${hh / 2}Z`;
    case 'triangle': case 'flowChartExtract': return poly([w * adj('adj', 50000), 0], [w, hh], [0, hh]);
    case 'rtTriangle': return poly([0, 0], [w, hh], [0, hh]);
    case 'diamond': case 'flowChartDecision': return poly([w / 2, 0], [w, hh / 2], [w / 2, hh], [0, hh / 2]);
    case 'parallelogram': case 'flowChartInputOutput': { const a = ss * adj('adj', 25000); return poly([a, 0], [w, 0], [w - a, hh], [0, hh]); }
    case 'trapezoid': { const a = ss * adj('adj', 25000); return poly([0, hh], [a, 0], [w - a, 0], [w, hh]); }
    case 'hexagon': { const a = ss * adj('adj', 25000); return poly([0, hh / 2], [a, 0], [w - a, 0], [w, hh / 2], [w - a, hh], [a, hh]); }
    case 'octagon': { const a = ss * adj('adj', 29289); return poly([a, 0], [w - a, 0], [w, a], [w, hh - a], [w - a, hh], [a, hh], [0, hh - a], [0, a]); }
    case 'pentagon': return poly([w / 2, 0], [w, hh * 0.38], [w * 0.81, hh], [w * 0.19, hh], [0, hh * 0.38]);
    case 'homePlate': { const a = ss * adj('adj', 50000); return poly([0, 0], [w - a, 0], [w, hh / 2], [w - a, hh], [0, hh]); }
    case 'chevron': { const a = ss * adj('adj', 50000); return poly([0, 0], [w - a, 0], [w, hh / 2], [w - a, hh], [0, hh], [a, hh / 2]); }
    case 'rightArrow': case 'leftArrow': {
      const t = hh * adj('adj1', 50000), a = ss * adj('adj2', 50000), y0 = (hh - t) / 2, y1 = (hh + t) / 2;
      const pts = [[0, y0], [w - a, y0], [w - a, 0], [w, hh / 2], [w - a, hh], [w - a, y1], [0, y1]];
      return poly(...(prst === 'leftArrow' ? pts.map(([x, y]) => [w - x, y]) : pts));
    }
    case 'upArrow': case 'downArrow': {
      const t = w * adj('adj1', 50000), a = ss * adj('adj2', 50000), x0 = (w - t) / 2, x1 = (w + t) / 2;
      const pts = [[x0, hh], [x0, a], [0, a], [w / 2, 0], [w, a], [x1, a], [x1, hh]];
      return poly(...(prst === 'downArrow' ? pts.map(([x, y]) => [x, hh - y]) : pts));
    }
    case 'star5': {
      const pts = [];
      for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.38 : 1, t = -Math.PI / 2 + i * Math.PI / 5; pts.push([w / 2 + w / 2 * r * Math.cos(t), hh / 2 + hh / 2 * r * Math.sin(t) * 1.05 + hh * 0.03]); }
      return poly(...pts);
    }
    case 'plus': { const a = ss * adj('adj', 25000); return poly([a, 0], [w - a, 0], [w - a, a], [w, a], [w, hh - a], [w - a, hh - a], [w - a, hh], [a, hh], [a, hh - a], [0, hh - a], [0, a], [a, a]); }
    case 'line': case 'straightConnector1': return `M0 0L${w} ${hh}`;
    case 'bentConnector2': return `M0 0L${w} 0L${w} ${hh}`;
    case 'bentConnector3': return `M0 0L${w / 2} 0L${w / 2} ${hh}L${w} ${hh}`;
    default: return `M0 0H${w}V${hh}H0Z`;
  }
}

// a:custGeom -> [{ d, fill, stroke }]
function customPaths(geom, w, hh) {
  return kids(kid(geom, 'pathLst'), 'path').map((p) => {
    const sx = num(A(p, 'w')) ? w / num(A(p, 'w')) : 1 / EMU, sy = num(A(p, 'h')) ? hh / num(A(p, 'h')) : 1 / EMU;
    const pt = (e) => [num(A(e, 'x')) * sx, num(A(e, 'y')) * sy];
    let d = '', cur = [0, 0];
    for (const c of p.children) {
      const pts = kids(c, 'pt').map(pt);
      switch (c.localName) {
        case 'moveTo': d += `M${pts[0].join(' ')}`; cur = pts[0]; break;
        case 'lnTo': d += `L${pts[0].join(' ')}`; cur = pts[0]; break;
        case 'cubicBezTo': d += `C${pts.map((q) => q.join(' ')).join(' ')}`; cur = pts[2]; break;
        case 'quadBezTo': d += `Q${pts.map((q) => q.join(' ')).join(' ')}`; cur = pts[1]; break;
        case 'close': d += 'Z'; break;
        case 'arcTo': {
          const wr = num(A(c, 'wR')) * sx, hr = num(A(c, 'hR')) * sy;
          const st = num(A(c, 'stAng')) / 60000 * Math.PI / 180, sw = num(A(c, 'swAng')) / 60000 * Math.PI / 180;
          const cx = cur[0] - wr * Math.cos(st), cy = cur[1] - hr * Math.sin(st);
          // In two halves, so a full circle still draws.
          for (const a of [st + sw / 2, st + sw]) {
            const e = [cx + wr * Math.cos(a), cy + hr * Math.sin(a)];
            d += `A${wr} ${hr} 0 0 ${sw > 0 ? 1 : 0} ${e.join(' ')}`;
            cur = e;
          }
          break;
        }
      }
    }
    return { d, fill: A(p, 'fill') !== 'none', stroke: A(p, 'stroke') !== '0' };
  });
}

/* text */

const ALIGN = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' };
const pt2px = (v) => v / PX;

function autoNumber(type, n) {
  const roman = (x) => [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']].reduce((s, [v, r]) => { while (x >= v) { s += r; x -= v; } return s; }, '');
  const alpha = (x) => String.fromCharCode(96 + ((x - 1) % 26) + 1);
  let s = /^alphaLc/.test(type) ? alpha(n) : /^alphaUc/.test(type) ? alpha(n).toUpperCase() : /^romanLc/.test(type) ? roman(n) : /^romanUc/.test(type) ? roman(n).toUpperCase() : String(n);
  if (/ParenBoth$/.test(type)) s = `(${s})`; else if (/ParenR$/.test(type)) s += ')'; else if (/Period$/.test(type)) s += '.';
  return s;
}

// Paragraphs of a txBody. t: { th, lists (lstStyle-like elements, most specific
// first), color (from the shape's style), scale, lnReduce, slideNo }.
function textBlock(txBody, t) {
  const box = h('div', { class: 'tp-txt' });
  const counters = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = num(A(pPr, 'lvl'));
    const levels = [pPr, ...t.lists.map((l) => kid(l, `lvl${lvl + 1}pPr`))].filter(Boolean);
    const attr = (n) => levels.map((l) => A(l, n)).find((v) => v != null) ?? null;
    const child = (n) => levels.map((l) => kid(l, n)).find(Boolean) || null;
    const runAttr = (rPr, n) => [rPr, ...levels.map((l) => kid(l, 'defRPr'))].map((r) => A(r, n)).find((v) => v != null) ?? null;
    const runKid = (rPr, n) => [rPr, ...levels.map((l) => kid(l, 'defRPr'))].map((r) => kid(r, n)).find(Boolean) || null;
    const runs = [...p.children].filter((c) => /^(r|br|fld)$/.test(c.localName));
    const firstR = kid(runs.find((r) => r.localName !== 'br'), 'rPr') || kid(p, 'endParaRPr');
    const sizeOf = (rPr) => pt2px(num(runAttr(rPr, 'sz'), 1800) / 100) * t.scale;
    const base = sizeOf(firstR);

    const spc = (n) => {
      const s = child(n);
      if (!s) return 0;
      const pts = kid(s, 'spcPts'), pct = kid(s, 'spcPct');
      return pts ? pt2px(num(A(pts, 'val')) / 100) : pct ? base * num(A(pct, 'val')) / 100000 * 1.2 : 0;
    };
    const ln = child('lnSpc');
    const lnPct = kid(ln, 'spcPct'), lnPts = kid(ln, 'spcPts');
    const lineHeight = lnPts ? pt2px(num(A(lnPts, 'val')) / 100) + 'px' : String(1.2 * (lnPct ? num(A(lnPct, 'val')) / 100000 : 1) * (1 - t.lnReduce));
    const marL = num(attr('marL')) / EMU, indent = num(attr('indent')) / EMU;
    const para = h('div', { class: 'tp-p', style: { textAlign: ALIGN[attr('algn')] || 'left', paddingLeft: marL + 'px', textIndent: indent + 'px', lineHeight, marginTop: spc('spcBef') + 'px', marginBottom: spc('spcAft') + 'px', fontSize: base + 'px' } });

    const color = (rPr) => {
      const own = fillOf(rPr, t.th);
      if (own?.color) return own.color;
      for (const l of levels.slice(pPr ? 1 : 0)) {
        if (t.own && l === kid(t.own, `lvl${lvl + 1}pPr`)) { const c = fillOf(kid(l, 'defRPr'), t.th); if (c?.color) return c.color; continue; }
        if (t.color) return t.color;
        const c = fillOf(kid(l, 'defRPr'), t.th);
        if (c?.color) return c.color;
      }
      return t.color || t.th.scheme.dk1;
    };
    const spanFor = (rPr, text) => {
      const typeface = A(runKid(rPr, 'latin'), 'typeface') || A(runKid(rPr, 'ea'), 'typeface');
      const face = typeface === '+mj-lt' ? t.th.major : typeface === '+mn-lt' || !typeface ? (t.major ? t.th.major : t.th.minor) : typeface;
      const u = runAttr(rPr, 'u'), strike = runAttr(rPr, 'strike'), baseline = num(runAttr(rPr, 'baseline'));
      const deco = [u && u !== 'none' && 'underline', strike && strike !== 'noStrike' && 'line-through'].filter(Boolean).join(' ');
      return h('span', { style: {
        fontFamily: fontStack(face), fontSize: sizeOf(rPr) * (baseline ? 0.7 : 1) + 'px', color: rgba(color(rPr)),
        fontWeight: runAttr(rPr, 'b') === '1' ? '700' : '400', fontStyle: runAttr(rPr, 'i') === '1' ? 'italic' : 'normal',
        textDecoration: deco || null, verticalAlign: baseline ? (baseline > 0 ? 'super' : 'sub') : null,
        letterSpacing: runAttr(rPr, 'spc') ? pt2px(num(runAttr(rPr, 'spc')) / 100) + 'px' : null,
        textTransform: runAttr(rPr, 'cap') === 'all' ? 'uppercase' : null,
      } }, text);
    };

    const hasText = runs.some((r) => r.localName !== 'br' && kid(r, 't')?.textContent);
    const bu = levels.map((l) => [...l.children].find((k) => /^bu(None|Char|AutoNum|Blip)$/.test(k.localName))).find(Boolean);
    while (counters.length > lvl + 1) counters.pop();
    if (bu?.localName !== 'buAutoNum') counters[lvl] = 0;
    if (hasText && bu && bu.localName !== 'buNone') {
      const bc = child('buClr');
      const bSize = child('buSzPct') ? num(A(child('buSzPct'), 'val')) / 100000 : 1;
      const bFont = A(child('buFont'), 'typeface');
      let mark = '•';
      if (bu.localName === 'buChar') mark = A(bu, 'char') || '•';
      else if (bu.localName === 'buAutoNum') { counters[lvl] = (counters[lvl] || num(A(bu, 'startAt'), 1) - 1) + 1; mark = autoNumber(A(bu, 'type') || 'arabicPeriod', counters[lvl]); }
      // Symbol-font bullets (Wingdings) map to private code points; show a plain bullet.
      if (/wingdings|symbol/i.test(bFont || '') && mark.charCodeAt(0) > 0xef00) mark = '•';
      if (/wingdings|symbol/i.test(bFont || '') && /^[§Øüq]$/.test(mark)) mark = { '§': '■', 'Ø': '➢', 'ü': '✓', q: '❑' }[mark];
      para.append(h('span', { class: 'tp-bu', style: {
        width: indent < 0 ? -indent + 'px' : null, marginRight: indent < 0 ? null : '0.4em',
        color: rgba(bc ? colorIn(bc, t.th) : color(firstR)), fontSize: base * bSize + 'px',
        fontFamily: bu.localName === 'buChar' && bFont && !/wingdings|symbol/i.test(bFont) ? fontStack(bFont) : fontStack(t.th.minor),
      } }, mark));
    }
    for (const r of runs) {
      if (r.localName === 'br') { para.append(h('br')); continue; }
      let text = kid(r, 't')?.textContent || '';
      if (r.localName === 'fld' && /slidenum/i.test(A(r, 'type') || '')) text = String(t.slideNo);
      if (text) para.append(spanFor(kid(r, 'rPr'), text));
    }
    // An empty paragraph still takes up a line.
    if (!hasText) para.append(spanFor(kid(p, 'endParaRPr') || firstR, '​'));
    box.append(para);
  }
  return box;
}

/* slides */

const phOf = (el) => {
  const nv = [...el.children].find((k) => /^nv/.test(k.localName));
  const ph = dig(nv, 'nvPr', 'ph');
  return ph && { type: A(ph, 'type') || 'obj', idx: A(ph, 'idx') };
};
const phKind = (type) => (type === 'ctrTitle' || type === 'title' ? 'title' : /^(dt|ftr|sldNum|hdr)$/.test(type) ? type : 'body');

function findPh(part, ph, byIdx) {
  const shapes = [...(dig(part, 'cSld', 'spTree')?.children || [])].filter((s) => phOf(s));
  return (byIdx && ph.idx != null && shapes.find((s) => phOf(s).idx === ph.idx))
    || shapes.find((s) => phOf(s).type === ph.type)
    || shapes.find((s) => phKind(phOf(s).type) === phKind(ph.type)) || null;
}

const xfrmOf = (el) => kid(kid(el, 'spPr') || kid(el, 'grpSpPr'), 'xfrm') || kid(el, 'xfrm');

// tf maps the part's EMU coordinates to slide px (groups have their own).
function boxOf(xfrm, tf) {
  const off = kid(xfrm, 'off'), ext = kid(xfrm, 'ext');
  return {
    x: tf.ox + (num(A(off, 'x')) - tf.cx) * tf.sx, y: tf.oy + (num(A(off, 'y')) - tf.cy) * tf.sy,
    w: num(A(ext, 'cx')) * tf.sx, h: num(A(ext, 'cy')) * tf.sy,
    rot: num(A(xfrm, 'rot')) / 60000, flipH: A(xfrm, 'flipH') === '1', flipV: A(xfrm, 'flipV') === '1',
  };
}
const ROOT_TF = { ox: 0, oy: 0, cx: 0, cy: 0, sx: 1 / EMU, sy: 1 / EMU };

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...children.filter(Boolean));
  return el;
}

async function shapeSvg(paths, b, fill, line, image) {
  const pad = Math.ceil((line ? line.w * 3 : 0) + 2);
  const defs = [];
  let paint = 'none';
  if (fill?.color) paint = rgba(fill.color);
  else if (fill?.stops) {
    const id = 'g' + uid();
    const a = fill.angle * Math.PI / 180;
    const stops = fill.stops.map((s) => svg('stop', { offset: s.pos + '%', 'stop-color': rgba(s.color && [...s.color.slice(0, 3), 1]), 'stop-opacity': s.color?.[3] ?? 1 }));
    defs.push(fill.radial ? svg('radialGradient', { id }, ...stops)
      : svg('linearGradient', { id, x1: 0.5 - Math.cos(a) / 2, y1: 0.5 - Math.sin(a) / 2, x2: 0.5 + Math.cos(a) / 2, y2: 0.5 + Math.sin(a) / 2 }, ...stops));
    paint = `url(#${id})`;
  } else if (fill?.blip && image) {
    const id = 'p' + uid();
    defs.push(svg('pattern', { id, patternUnits: 'objectBoundingBox', width: 1, height: 1 }, svg('image', { href: image, width: b.w, height: b.h, preserveAspectRatio: 'none' })));
    paint = `url(#${id})`;
  }
  let markers = {};
  if (line && (line.head || line.tail)) {
    const id = 'm' + uid();
    defs.push(svg('marker', { id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' }, svg('path', { d: 'M0 0L10 5L0 10Z', fill: rgba(line.color) })));
    markers = { 'marker-start': line.head ? `url(#${id})` : null, 'marker-end': line.tail ? `url(#${id})` : null };
  }
  const flip = `${b.flipH ? `translate(${b.w} 0) scale(-1 1)` : ''}${b.flipV ? ` translate(0 ${b.h}) scale(1 -1)` : ''}`;
  return svg('svg', { class: 'tp-svg', width: b.w + 2 * pad, height: b.h + 2 * pad, style: `left:${-pad}px;top:${-pad}px` },
    defs.length && svg('defs', {}, ...defs),
    svg('g', { transform: `translate(${pad} ${pad}) ${flip}` }, ...paths.map((p) => svg('path', {
      d: p.d, fill: p.fill ? paint : 'none', stroke: p.stroke && line ? rgba(line.color) : 'none', 'stroke-width': line?.w,
      'stroke-dasharray': line?.dash, 'stroke-linejoin': 'round', ...markers,
    }))));
}

const placed = (b, cls = 'tp-sh') => h('div', { class: cls, style: { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px', transform: b.rot ? `rotate(${b.rot}deg)` : null } });

async function renderSlide(deck, path, slideNo) {
  const slide = await deck.xml(path);
  const sRels = await deck.rels(path);
  const layoutPath = Object.values(sRels).find((r) => r.type === 'slideLayout')?.path;
  const layout = await deck.xml(layoutPath);
  const lRels = layoutPath ? await deck.rels(layoutPath) : {};
  const masterPath = Object.values(lRels).find((r) => r.type === 'slideMaster')?.path;
  const master = await deck.xml(masterPath);
  const mRels = masterPath ? await deck.rels(masterPath) : {};
  if (!deck.themes.has(masterPath)) deck.themes.set(masterPath, themeOf(await deck.xml(Object.values(mRels).find((r) => r.type === 'theme')?.path), master));
  const th = deck.themes.get(masterPath);
  const txStyles = kid(master, 'txStyles');

  const parts = { slide: { el: slide, rels: sRels, path }, layout: { el: layout, rels: lRels, path: layoutPath }, master: { el: master, rels: mRels, path: masterPath } };
  const picture = async (blip, part) => {
    if (!blip) return null;
    const target = part.rels[rid(blip)]?.path;
    const src = target ? await deck.image(target) : null;
    // A file that is there but can't be shown (EMF…), or one that is missing or linked from outside.
    if (!src) (deck.has(target) ? deck.missing.odd : deck.missing.gone).add(target || `${part.path}#${rid(blip)}`);
    return src;
  };

  const root = h('div', { class: 'tp-slide', style: { width: deck.W + 'px', height: deck.H + 'px' } });

  // Background: the slide's own, else the layout's, else the master's.
  for (const part of [parts.slide, parts.layout, parts.master]) {
    const bg = dig(part.el, 'cSld', 'bg');
    if (!bg) continue;
    const ref = styleRef(kid(bg, 'bgRef'), th.fills, th);
    const f = kid(bg, 'bgPr') ? fillOf(kid(bg, 'bgPr'), th) : ref && fillFrom(ref.el, th, ref.ph);
    if (f?.color) root.style.background = rgba(f.color);
    else if (f?.stops) root.style.backgroundImage = `${f.radial ? 'radial-gradient(circle' : `linear-gradient(${f.angle + 90}deg`}, ${f.stops.map((s) => `${rgba(s.color)} ${s.pos}%`).join(', ')})`;
    else if (f?.blip) {
      const src = await picture(f.blip, part);
      if (src) Object.assign(root.style, { backgroundImage: `url("${src}")`, backgroundSize: f.tile ? 'auto' : '100% 100%', backgroundRepeat: f.tile ? 'repeat' : 'no-repeat' });
    }
    break;
  }

  const draw = async (tree, part, into, tf) => {
    for (let el of tree?.children || []) {
      // Newer content with a fallback (equations, 3D models): use the fallback.
      if (el.localName === 'AlternateContent') el = kid(kid(el, 'Fallback'), 'sp') || kid(kid(el, 'Fallback'), 'pic') || kid(kid(el, 'Fallback'), 'grpSp') || kid(kid(el, 'Fallback'), 'graphicFrame');
      if (!el) continue;
      const ph = phOf(el);
      // Placeholders on layouts and masters are prompts, not content.
      if (ph && part !== parts.slide) continue;
      const lph = ph && findPh(layout, ph, true);
      const mph = ph && findPh(master, lph ? phOf(lph) : ph, false);
      const xfrm = xfrmOf(el) || xfrmOf(lph) || xfrmOf(mph);
      if (!xfrm && el.localName !== 'grpSp') continue;
      const b = xfrm && boxOf(xfrm, tf);
      switch (el.localName) {
        case 'sp': case 'cxnSp': into.append(await shape(el, part, b, ph, lph, mph)); break;
        case 'pic': into.append(await pic(el, part, b)); break;
        case 'grpSp': {
          const g = kid(kid(el, 'grpSpPr'), 'xfrm');
          const ch = kid(g, 'chOff'), che = kid(g, 'chExt');
          const sx = num(A(che, 'cx')) ? b.w / num(A(che, 'cx')) : tf.sx, sy = num(A(che, 'cy')) ? b.h / num(A(che, 'cy')) : tf.sy;
          await draw(el, part, into, g ? { ox: b.x, oy: b.y, cx: num(A(ch, 'x')), cy: num(A(ch, 'y')), sx, sy } : tf);
          break;
        }
        case 'graphicFrame': into.append(await frameEl(el, part, b)); break;
      }
    }
  };

  const shape = async (el, part, b, ph, lph, mph) => {
    const spPr = kid(el, 'spPr');
    const style = kid(el, 'style');
    const wrap = placed(b);
    const geom = kid(spPr, 'prstGeom') || kid(spPr, 'custGeom') || kid(kid(lph, 'spPr'), 'prstGeom');
    const fRef = styleRef(kid(style, 'fillRef'), th.fills, th);
    const fill = fillOf(spPr, th) || fillOf(kid(lph, 'spPr'), th) || fillOf(kid(mph, 'spPr'), th) || (fRef && fillFrom(fRef.el, th, fRef.ph));
    const line = lineOf(spPr, style, th);
    const visible = (fill && !fill.none) || line;
    if (visible) {
      const paths = geom?.localName === 'custGeom' ? customPaths(geom, b.w, b.h) : [{ d: presetPath(geom, b.w, b.h), fill: !/^(line|straightConnector1|bentConnector\d)$/.test(A(geom, 'prst')), stroke: true }];
      wrap.append(await shapeSvg(paths, b, fill, line, fill?.blip && await picture(fill.blip, part)));
    }
    const tx = kid(el, 'txBody');
    if (tx && kids(tx, 'p').some((p) => p.textContent.trim())) {
      const kind = ph ? phKind(ph.type) : null;
      const bodies = [kid(tx, 'bodyPr'), kid(kid(lph, 'txBody'), 'bodyPr'), kid(kid(mph, 'txBody'), 'bodyPr')].filter(Boolean);
      const bp = (n, d) => bodies.map((x) => A(x, n)).find((v) => v != null) ?? d;
      const fit = bodies.map((x) => kid(x, 'normAutofit')).find(Boolean);
      const ins = (n, d) => num(bp(n, d)) / EMU;
      const inner = textBlock(tx, {
        th, slideNo, own: kid(tx, 'lstStyle'),
        lists: [kid(tx, 'lstStyle'), kid(kid(lph, 'txBody'), 'lstStyle'), kid(kid(mph, 'txBody'), 'lstStyle'),
          kind ? kid(txStyles, kind === 'title' ? 'titleStyle' : kind === 'body' ? 'bodyStyle' : 'otherStyle') : deck.defaults].filter(Boolean),
        color: style && colorIn(kid(style, 'fontRef'), th),
        major: kind === 'title',
        scale: fit ? num(A(fit, 'fontScale'), 100000) / 100000 : 1,
        lnReduce: fit ? num(A(fit, 'lnSpcReduction')) / 100000 : 0,
      });
      const anchor = bp('anchor', kind === 'title' ? 'ctr' : 't');
      const vert = bp('vert', 'horz');
      wrap.append(h('div', { class: 'tp-tbox', style: {
        padding: `${ins('tIns', 45720)}px ${ins('rIns', 91440)}px ${ins('bIns', 45720)}px ${ins('lIns', 91440)}px`,
        justifyContent: { ctr: 'center', b: 'flex-end' }[anchor] || 'flex-start',
        whiteSpace: bp('wrap', 'square') === 'none' ? 'pre' : 'pre-wrap',
        writingMode: /^vert/.test(vert) && vert !== 'horz' ? 'vertical-rl' : null,
        transform: vert === 'vert270' ? 'rotate(180deg)' : null,
      } }, inner));
    }
    return wrap;
  };

  const pic = async (el, part, b) => {
    const blip = dig(el, 'blipFill', 'blip');
    const src = await picture(blip, part);
    const wrap = placed(b, 'tp-sh tp-pic');
    if (!src) return wrap;
    const crop = dig(el, 'blipFill', 'srcRect');
    const [l, t, r, bt] = ['l', 't', 'r', 'b'].map((k) => num(A(crop, k)) / 100000);
    const iw = b.w / Math.max(0.01, 1 - l - r), ih = b.h / Math.max(0.01, 1 - t - bt);
    const prst = A(dig(el, 'spPr', 'prstGeom'), 'prst');
    if (prst === 'ellipse') wrap.style.borderRadius = '50%';
    else if (prst === 'roundRect') wrap.style.borderRadius = Math.min(b.w, b.h) * 0.1667 + 'px';
    const alpha = kid(blip, 'alphaModFix');
    wrap.append(h('img', { src, alt: '', style: {
      left: -l * iw + 'px', top: -t * ih + 'px', width: iw + 'px', height: ih + 'px',
      opacity: alpha ? num(A(alpha, 'amt'), 100000) / 100000 : null,
      transform: b.flipH || b.flipV ? `scale(${b.flipH ? -1 : 1}, ${b.flipV ? -1 : 1})` : null,
    } }));
    return wrap;
  };

  const frameEl = async (el, part, b) => {
    const data = dig(el, 'graphic', 'graphicData');
    const tbl = kid(data, 'tbl');
    if (tbl) return tableEl(tbl, b);
    // SmartArt keeps a ready-drawn copy of itself; draw that.
    const relIds = kid(data, 'relIds');
    if (relIds) {
      const dm = await deck.xml(part.rels[rid(relIds, 'dm')]?.path);
      const ext = dm && [...dm.getElementsByTagName('*')].find((x) => x.localName === 'dataModelExt');
      const drawing = await deck.xml(part.rels[A(ext, 'relId')]?.path);
      const g = placed({ ...b, rot: 0 });
      g.style.overflow = 'visible';
      if (drawing) await draw(kid(drawing, 'spTree'), part, g, { ox: 0, oy: 0, cx: 0, cy: 0, sx: 1 / EMU, sy: 1 / EMU });
      return g;
    }
    deck.missing.charts++;
    return placed(b);
  };

  const tableEl = (tbl, b) => {
    const pr = kid(tbl, 'tblPr');
    const flag = (n) => A(pr, n) === '1';
    const id = kid(pr, 'tableStyleId')?.textContent;
    const ts = kids(deck.tableStyles, 'tblStyle').find((x) => A(x, 'styleId') === id) || (id || !kid(pr, 'tableStyleId') ? DEFAULT_TABLE() : null);
    const rows = kids(tbl, 'tr');
    const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => num(A(c, 'w')) / EMU);
    const table = h('table', { class: 'tp-tbl', style: { width: cols.reduce((a, c) => a + c, 0) + 'px' } }, h('colgroup', {}, cols.map((w) => h('col', { style: { width: w + 'px' } }))));
    rows.forEach((tr, ri) => {
      const row = h('tr', { style: { height: num(A(tr, 'h')) / EMU + 'px' } });
      const band = flag('firstRow') ? ri - 1 : ri;
      const partsFor = [
        'wholeTbl',
        flag('bandRow') && band >= 0 && !(flag('lastRow') && ri === rows.length - 1) && (band % 2 ? 'band2H' : 'band1H'),
        flag('lastRow') && ri === rows.length - 1 && 'lastRow',
        flag('firstRow') && ri === 0 && 'firstRow',
      ].filter(Boolean).map((n) => kid(ts, n)).filter(Boolean);
      kids(tr, 'tc').forEach((tc) => {
        if (A(tc, 'hMerge') === '1' || A(tc, 'vMerge') === '1') return;
        const tcPr = kid(tc, 'tcPr');
        let fill = fillOf(tcPr, th), color = null, bold = false;
        for (const p of partsFor) {
          const st = kid(p, 'tcStyle'), tx = kid(p, 'tcTxStyle');
          if (!fillOf(tcPr, th)) {
            const ref = styleRef(kid(st, 'fillRef'), th.fills, th);
            fill = fillOf(kid(st, 'fill'), th) || (ref && fillFrom(ref.el, th, ref.ph)) || fill;
          }
          color = colorIn(tx, th) || color;
          if (A(tx, 'b') === 'on') bold = true;
        }
        const border = (n, sn) => {
          const ln = kid(tcPr, n);
          const lf = fillOf(ln, th);
          if (lf) return lf.color ? `${Math.max(0.5, num(A(ln, 'w'), 12700) / EMU)}px solid ${rgba(lf.color)}` : 'none';
          const sl = sn.map((x) => dig(kid(ts, 'wholeTbl'), 'tcStyle', 'tcBdr', x, 'ln')).find(Boolean);
          const sf = fillOf(sl, th);
          return sf?.color ? `${Math.max(0.5, num(A(sl, 'w'), 12700) / EMU)}px solid ${rgba(sf.color)}` : null;
        };
        const cell = h('td', {
          colspan: A(tc, 'gridSpan'), rowspan: A(tc, 'rowSpan'),
          style: {
            background: fill?.color ? rgba(fill.color) : null,
            padding: `${num(A(tcPr, 'marT'), 45720) / EMU}px ${num(A(tcPr, 'marR'), 91440) / EMU}px ${num(A(tcPr, 'marB'), 45720) / EMU}px ${num(A(tcPr, 'marL'), 91440) / EMU}px`,
            verticalAlign: { ctr: 'middle', b: 'bottom' }[A(tcPr, 'anchor')] || 'top',
            borderLeft: border('lnL', ['left', 'insideV']), borderRight: border('lnR', ['right', 'insideV']),
            borderTop: border('lnT', ['top', 'insideH']), borderBottom: border('lnB', ['bottom', 'insideH']),
            fontWeight: bold ? '700' : null,
          },
        }, textBlock(kid(tc, 'txBody'), { th, slideNo, lists: [kid(kid(tc, 'txBody'), 'lstStyle'), deck.defaults].filter(Boolean), color, scale: 1, lnReduce: 0 }));
        if (bold) cell.querySelectorAll('span').forEach((s) => (s.style.fontWeight = '700'));
        row.append(cell);
      });
      table.append(row);
    });
    const wrap = placed({ ...b, h: b.h });
    wrap.style.height = 'auto';
    wrap.append(table);
    return wrap;
  };

  const showMaster = (el) => A(el, 'showMasterSp') !== '0';
  if (showMaster(slide) && showMaster(layout)) await draw(dig(master, 'cSld', 'spTree'), parts.master, root, ROOT_TF);
  if (showMaster(slide)) await draw(dig(layout, 'cSld', 'spTree'), parts.layout, root, ROOT_TF);
  await draw(dig(slide, 'cSld', 'spTree'), parts.slide, root, ROOT_TF);
  return root;
}

// PowerPoint's default table look (Medium Style 2, Accent 1), for decks that
// use it without saving its definition.
let defaultTable = null;
const DEFAULT_TABLE = () => (defaultTable ||= new DOMParser().parseFromString(`<a:tblStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:wholeTbl><a:tcTxStyle><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${['left', 'right', 'top', 'bottom', 'insideH', 'insideV'].map((s) => `<a:${s}><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:${s}>`).join('')}</a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>
<a:band1H><a:tcStyle><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H>
<a:lastRow><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:lastRow>
<a:firstRow><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>
</a:tblStyle>`, 'application/xml').documentElement);

const SLIDE_CSS = `
body { margin: 0; background: #fff; }
.tp-slide { position: relative; overflow: hidden; background: #fff; margin-bottom: 20px; }
.tp-sh { position: absolute; transform-origin: center; }
.tp-pic { overflow: hidden; }
.tp-pic img { position: absolute; max-width: none; }
.tp-svg { position: absolute; overflow: visible; }
.tp-tbox { position: absolute; inset: 0; display: flex; flex-direction: column; box-sizing: border-box; overflow-wrap: break-word; }
.tp-p { margin: 0; }
.tp-bu { display: inline-block; text-indent: 0; }
.tp-tbl { border-collapse: collapse; table-layout: fixed; }
.tp-tbl td { overflow-wrap: break-word; }`;

async function pptToPdf(item, pdf, font, progress, s) {
  await lib('canvas');
  const deck = await openDeck(item.file);
  const fr = await frame(Math.ceil(deck.W), Math.ceil(deck.H));
  try {
    const doc = fr.contentDocument;
    doc.head.append(Object.assign(doc.createElement('style'), { textContent: SLIDE_CSS }));
    let shown = 0, hidden = 0;
    for (const [i, path] of deck.slides.entries()) {
      progress(i + 1, deck.slides.length);
      if (A(await deck.xml(path), 'show') === '0' && !s.hidden) { hidden++; continue; }
      const el = await renderSlide(deck, path, i + 1);
      doc.body.replaceChildren(el);
      await settle(doc);
      const page = pdf.addPage([deck.W * PX, deck.H * PX]);
      await paint(pdf, page, el, { y0: 0, y1: deck.H, w: deck.W, left: 0, top: 0, k: PX });
      const r = el.getBoundingClientRect();
      addWords(page, font, wordsIn(el, (x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom), { k: PX, map: (x, y) => [(x - r.left) * PX, (y - r.top) * PX] });
      shown++;
    }
    if (!shown) throw new Error(`“${item.name}” has no slides to convert.`);
    const notes = [
      hidden && `${hidden} hidden slide${hidden > 1 ? 's were' : ' was'} left out`,
      deck.missing.charts && `${deck.missing.charts} chart${deck.missing.charts > 1 ? 's' : ''} could not be drawn`,
      deck.missing.odd.size && `${deck.missing.odd.size} picture${deck.missing.odd.size > 1 ? 's' : ''} in a format browsers can’t show (like EMF) ${deck.missing.odd.size > 1 ? 'were' : 'was'} left out`,
      deck.missing.gone.size && `${deck.missing.gone.size} picture${deck.missing.gone.size > 1 ? 's' : ''} missing from the file (or linked from outside it) ${deck.missing.gone.size > 1 ? 'were' : 'was'} left out`,
    ].filter(Boolean);
    return notes.length ? notes.join('; ') + '.' : null;
  } finally {
    fr.remove();
  }
}

const pptToPdfTool = {
  id: 'ppt-to-pdf', keywords: 'pptx ppt powerpoint slides presentation deck keynote convert', title: 'PowerPoint to PDF', icon: 'tpSlides', color: '#ea580c', cat: 'convert',
  accept: { accept: '.pptx,.ppt,application/vnd.openxmlformats-officedocument.presentationml.presentation', test: (f) => /\.pptx?$/i.test(f.name), label: 'PowerPoint files' },
  multiple: true, action: 'Convert to PDF', busyText: 'Converting…',
  desc: 'Turn slide decks into PDF, one page per slide.',
  long: 'Turn .pptx decks into PDF, one page per slide at the slide’s own shape. Backgrounds, pictures, shapes, text, tables and SmartArt are drawn; charts, animations and some effects are not. Text stays searchable.',
  setup(ctx) {
    const s = ctx.state = { oneFile: false, hidden: false };
    const warn = h('p', { class: 'small bad', hidden: true });
    const one = h('div', {}, check('Put all files in one PDF', s.oneFile, (v) => (s.oneFile = v)));
    const sync = () => {
      const old = ctx.items.filter(isOld);
      warn.hidden = !old.length;
      warn.textContent = old.length ? 'Browsers can’t read old .ppt files. Open it in PowerPoint, Keynote, LibreOffice or Google Slides, save it as .pptx, and add the new file.' : '';
      one.hidden = ctx.items.length < 2;
      ctx.action.disabled = !ctx.items.some((it) => !isOld(it));
    };
    ctx.main.append(fileCards(ctx, { ext: 'pptx', color: '#ea580c', label: 'PowerPoint file', bad: oldNote, onChange: sync }));
    ctx.side.append(
      h('p', { class: 'muted small' }, 'Each slide becomes one page, the same shape as the slide.'),
      check('Include hidden slides', s.hidden, (v) => (s.hidden = v)),
      one, warn);
    sync();
  },
  async run(ctx) {
    const items = ctx.items.filter((it) => !isOld(it));
    const { files, notes } = await convertAll(items, ctx.state.oneFile, 'slides.pdf', (it, pdf, font, progress) => pptToPdf(it, pdf, font, progress, ctx.state));
    return { files, zipName: 'slides-pdf.zip', title: files.length > 1 ? `${files.length} PDFs are ready` : 'Your PDF is ready', note: notes.join(' ') };
  },
};

/* ---------- Excel ---------- */

const SHEET_CSS = `
.tp-sheet table { border-collapse: collapse; table-layout: fixed; font: 11pt/1.15 Calibri, Carlito, Arial, sans-serif; color: #000; background: #fff; }
.tp-sheet td { padding: 0 4px; white-space: nowrap; overflow: hidden; vertical-align: bottom; box-sizing: border-box; }
.tp-sheet td.n { text-align: right; }
.tp-sheet td.spill { overflow: visible; }
.tp-sheet.grid td { border: 1px solid #c8c8c8; }`;

// The used part of a sheet, its visible rows and columns, sizes in px, and merges.
function sheetModel(ws) {
  const X = window.XLSX;
  let r1 = -1, c1 = -1;
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue;
    const cell = ws[key];
    if (cell.v == null || cell.v === '') continue;
    const { r, c } = X.utils.decode_cell(key);
    if (r > r1) r1 = r;
    if (c > c1) c1 = c;
  }
  for (const m of ws['!merges'] || []) { r1 = Math.max(r1, m.e.r); c1 = Math.max(c1, m.e.c); }
  if (r1 < 0) return null;
  const text = (r, c) => {
    const cell = ws[X.utils.encode_cell({ r, c })];
    return cell ? { t: cell.w ?? (cell.v == null ? '' : String(cell.v)), n: cell.t === 'n' || cell.t === 'd', fill: cell.s?.patternType === 'solid' && cell.s.fgColor?.rgb } : null;
  };
  const colInfo = ws['!cols'] || [];
  const rowInfo = ws['!rows'] || [];
  const cols = [], rows = [];
  for (let c = 0; c <= c1; c++) if (!colInfo[c]?.hidden) cols.push(c);
  for (let r = 0; r <= r1; r++) if (!rowInfo[r]?.hidden) rows.push(r);
  // Without saved widths (CSV), size columns to their text.
  const width = {};
  for (const c of cols) {
    const ci = colInfo[c];
    if (ci?.wpx) width[c] = ci.wpx;
    else if (ci?.wch) width[c] = Math.round(ci.wch * 7 + 5);
    else if (ci?.width) width[c] = Math.round(ci.width * 7 + 5);
    else {
      let most = 0;
      for (const r of rows.slice(0, 500)) most = Math.max(most, (text(r, c)?.t || '').length);
      width[c] = Math.min(320, Math.max(64, most * 7.5 + 10));
    }
  }
  const height = {};
  for (const r of rows) height[r] = Math.max(18, Math.round(rowInfo[r]?.hpx || (rowInfo[r]?.hpt ? rowInfo[r].hpt / PX : 20)));
  const merges = (ws['!merges'] || []).map((m) => ({ r0: m.s.r, c0: m.s.c, r1: m.e.r, c1: m.e.c }));
  return { rows, cols, width, height, merges, text };
}

// A table with just these rows and columns of the sheet.
function sheetTable(m, rows, cols, grid) {
  const rowSet = new Set(rows), colSet = new Set(cols);
  const mergeAt = (r, c) => m.merges.find((g) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1);
  const table = h('table', { style: { width: cols.reduce((t, c) => t + m.width[c], 0) + 'px' } },
    h('colgroup', {}, cols.map((c) => h('col', { style: { width: m.width[c] + 'px' } }))));
  for (const r of rows) {
    const tr = h('tr', { style: { height: m.height[r] + 'px' } });
    cols.forEach((c, ci) => {
      const g = mergeAt(r, c);
      let rs = 1, cs = 1, cell = m.text(r, c);
      if (g) {
        // The merge's first cell on this page carries it; the rest are covered.
        const firstR = rows.find((x) => x >= g.r0 && x <= g.r1), firstC = cols.find((x) => x >= g.c0 && x <= g.c1);
        if (r !== firstR || c !== firstC) return;
        rs = rows.filter((x) => x >= g.r0 && x <= g.r1).length;
        cs = cols.filter((x) => x >= g.c0 && x <= g.c1).length;
        cell = rowSet.has(g.r0) && colSet.has(g.c0) ? m.text(g.r0, g.c0) : null;
      }
      // Like Excel, text runs on over empty cells to its right.
      const next = cols[ci + 1];
      const spill = cell?.t && !cell.n && cs === 1 && next != null && !m.text(r, next)?.t && !mergeAt(r, next);
      tr.append(h('td', {
        rowspan: rs > 1 ? rs : null, colspan: cs > 1 ? cs : null,
        class: [cell?.n && 'n', spill && 'spill'].filter(Boolean).join(' ') || null,
        style: cell?.fill ? { background: '#' + cell.fill.slice(-6) } : null,
      }, cell?.t || ''));
    });
    table.append(tr);
  }
  return h('div', { class: 'tp-sheet' + (grid ? ' grid' : '') }, h('style', {}, SHEET_CSS), table);
}

async function readBook(item) {
  await lib('xlsx');
  const bad = () => new Error(`“${item.name}” could not be read as a spreadsheet.`);
  const buf = await item.file.arrayBuffer();
  const u = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  // .xlsx, .xlsm and .ods are ZIP files; anything else would be misread as CSV text.
  if (!buf.byteLength || (/\.(xlsx|xlsm|ods)$/i.test(item.name) && !(u[0] === 0x50 && u[1] === 0x4b))) throw bad();
  try {
    const opts = { cellStyles: true, cellDates: true, dense: false };
    if (/\.csv$/i.test(item.name)) {
      // SheetJS reads CSV bytes as Windows-1252; most CSVs are UTF-8 (with or without a BOM).
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
      return window.XLSX.read(text, { ...opts, type: 'string' });
    }
    return window.XLSX.read(buf, { ...opts, type: 'array' });
  } catch (err) {
    console.error(err);
    throw bad();
  }
}

async function excelToPdf(item, pdf, font, progress, s) {
  await lib('canvas');
  const book = s.book;
  const names = book.SheetNames.filter((n) => s.sheets.has(n));
  // Lay out all pages first, so the progress can count them.
  const jobs = [];
  for (const name of names) {
    const m = sheetModel(book.Sheets[name]);
    if (!m) continue;
    const tableW = m.cols.reduce((t, c) => t + m.width[c], 0);
    const [PW, PH] = pageSize(s, tableW * PX > SIZES[s.size][0] - 2 * s.margin);
    const cw = (PW - 2 * s.margin) / PX, ch = (PH - 2 * s.margin) / PX;
    const k = s.fit ? Math.min(1, cw / tableW) : 1;
    // Columns that fit across one page (all of them when fitting to width).
    const groups = [];
    let cur = [], used = 0;
    for (const c of m.cols) {
      if (cur.length && used + m.width[c] > cw / k + 0.5) { groups.push(cur); cur = []; used = 0; }
      cur.push(c); used += m.width[c];
    }
    groups.push(cur);
    const head = s.repeat && m.rows.length > 1 ? m.rows[0] : null;
    const pages = [];
    let rows = [], hgt = 0;
    for (const r of m.rows) {
      const room = ch / k - (head != null && pages.length ? m.height[head] : 0);
      if (rows.length && hgt + m.height[r] > room) { pages.push(rows); rows = []; hgt = 0; }
      rows.push(r); hgt += m.height[r];
    }
    pages.push(rows);
    // Excel's order: down, then over.
    for (const cols of groups) pages.forEach((rs, i) => jobs.push({ m, cols, rows: i && head != null ? [head, ...rs] : rs, PW, PH, k }));
  }
  if (!jobs.length) throw new Error('The sheets you picked are empty.');
  const fr = await frame(800, 800);
  try {
    const doc = fr.contentDocument;
    for (const [i, j] of jobs.entries()) {
      progress(i + 1, jobs.length);
      const wrap = sheetTable(j.m, j.rows, j.cols, s.grid);
      doc.body.replaceChildren(wrap);
      doc.body.style.margin = '0';
      const t = wrap.querySelector('table');
      const r = t.getBoundingClientRect();
      const page = pdf.addPage([j.PW, j.PH]);
      const k = j.k * PX;
      // The same pixels per point however far the table is shrunk (paint also caps the canvas).
      await paint(pdf, page, t, { y0: 0, y1: r.height, w: r.width, left: s.margin, top: s.margin, k, scale: Math.max(1, SCALE * j.k) });
      addWords(page, font, wordsIn(t), { k, map: (x, y) => [s.margin + (x - r.left) * k, s.margin + (y - r.top) * k] });
    }
    return null;
  } finally {
    fr.remove();
  }
}

const excelToPdfTool = {
  id: 'excel-to-pdf', keywords: 'xlsx xls ods csv spreadsheet sheet table convert', title: 'Excel to PDF', icon: 'tpSheet', color: '#16a34a', cat: 'convert',
  accept: { accept: '.xlsx,.xlsm,.xls,.ods,.csv', test: (f) => /\.(xlsx|xlsm|xls|ods|csv)$/i.test(f.name), label: 'spreadsheet' },
  action: 'Convert to PDF', busyText: 'Converting…', wide: true,
  desc: 'Turn spreadsheets into neat PDF pages.',
  long: 'Turn Excel, OpenDocument and CSV files into PDF tables. Pick the sheets, fit them to the page width and repeat the first row on every page. Cell values, column widths, merged cells and fill colors are kept; fonts, borders and charts are not.',
  async setup(ctx) {
    const item = ctx.items[0];
    const s = ctx.state = { size: 'a4', orient: 'auto', margin: 28, fit: true, grid: true, repeat: true, sheets: new Set(), book: null };
    const preview = h('div', { class: 'tp-sheetview' });
    const sheets = h('div', { class: 'tp-sheets' });
    ctx.main.append(h('div', { class: 'tp-file' }, h('span', { class: 'tp-doc tp-doc--sm', style: { '--tp': '#16a34a' } }, (item.name.split('.').pop() || 'xlsx').toUpperCase()),
      h('div', { class: 'card__meta' }, h('strong', { title: item.name }, item.name), h('span', {}, fmtSize(item.size)))), preview);
    ctx.side.append(field('Sheets', sheets), field('Page size', segmented([['a4', 'A4'], ['letter', 'Letter']], s.size, (v) => (s.size = v))),
      orientField(s), marginField(s),
      check('Fit to page width', s.fit, (v) => (s.fit = v)),
      check('Show gridlines', s.grid, (v) => { s.grid = v; show(shown); }),
      check('Repeat first row on every page', s.repeat, (v) => (s.repeat = v)));
    ctx.action.disabled = true;
    let shown = null;
    const show = (name) => {
      shown = name;
      const m = name && sheetModel(s.book.Sheets[name]);
      preview.replaceChildren(m ? sheetTable(m, m.rows.slice(0, 60), m.cols.slice(0, 26), s.grid) : h('p', { class: 'muted' }, 'This sheet is empty.'));
    };
    busy('Reading…');
    try {
      s.book = await readBook(item);
    } catch (err) {
      busy(false);
      preview.replaceChildren(h('p', { class: 'bad' }, err.message));
      return;
    }
    busy(false);
    const sync = () => { ctx.action.disabled = !s.sheets.size; };
    sheets.replaceChildren(...s.book.SheetNames.map((name, i) => {
      const m = sheetModel(s.book.Sheets[name]);
      // Like Excel, hidden sheets are not printed unless asked for.
      const hidden = !!s.book.Workbook?.Sheets?.[i]?.Hidden;
      if (m && !hidden) s.sheets.add(name);
      return h('div', { class: 'tp-sheetrow' },
        check(hidden ? `${name} (hidden)` : name, !!m && !hidden, (v) => { v ? s.sheets.add(name) : s.sheets.delete(name); sync(); }),
        h('button', { type: 'button', class: 'linkbtn', title: 'Preview this sheet', 'aria-label': `Preview ${name}`, onclick: () => show(name) }, m ? `${m.rows.length} row${m.rows.length === 1 ? '' : 's'}` : 'empty'));
    }));
    show(s.book.SheetNames.find((n) => s.sheets.has(n)) || s.book.SheetNames.find((n) => sheetModel(s.book.Sheets[n])) || null);
    sync();
  },
  async run(ctx) {
    const { files } = await convertAll(ctx.items, true, 'sheets.pdf', (it, pdf, font, progress) => excelToPdf(it, pdf, font, progress, ctx.state));
    return { files, title: 'Your PDF is ready' };
  },
};

/* ---------- HTML ---------- */

// Attributes that make the browser fetch something.
const FETCH_ATTRS = /^(src|poster|background|lowsrc|dynsrc|data|icon|manifest|ping|xlink:href)$/i;

// Takes out everything that could run or navigate, and pins down a base
// address so a fetched page finds its pictures and styles. Nothing may be
// fetched from other websites: an uploaded or pasted page could hold tracking
// pictures. A page fetched by web address may load from its own site only.
// The references are taken out here, not just blocked by the frame's policy,
// because html2canvas loads pictures again from the app's own window.
function cleanHtml(html, base) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, portal, meta[http-equiv], base').forEach((el) => el.remove());
  const origin = base ? new URL(base).origin : '';
  let blocked = 0;
  const ok = (v) => {
    v = (v || '').trim();
    if (!v || v[0] === '#' || /^(data|blob):/i.test(v)) return true;
    if (!origin) return false;
    try { return new URL(v, base).origin === origin; } catch { return false; }
  };
  const css = (text) => text
    .replace(/@import\s+(['"])(.*?)\1[^;]*;?/gi, (m, q, u) => (ok(u) ? m : (blocked++, '')))
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => (ok(u) ? m : (blocked++, 'url("data:,")')));
  for (const el of d.querySelectorAll('link')) {
    if (/(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') || '') && ok(el.getAttribute('href'))) continue;
    // Prefetch, preconnect, icons…: none are needed for a picture of the page.
    if (el.getAttribute('href')) blocked++;
    el.remove();
  }
  for (const el of d.querySelectorAll('style')) el.textContent = css(el.textContent);
  for (const el of d.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (/^on/.test(n) || /^\s*(javascript|vbscript):/i.test(a.value)) el.removeAttribute(a.name);
      else if (n === 'style') { if (/url\(|@import/i.test(a.value)) el.setAttribute('style', css(a.value)); }
      else if (n === 'srcset' || n === 'imagesrcset') {
        const keep = a.value.split(/,\s+/).filter((c) => ok(c.trim().split(/\s+/)[0]));
        if (keep.length < a.value.split(/,\s+/).length) blocked++;
        if (keep.length) el.setAttribute(a.name, keep.join(', ')); else { el.removeAttribute(a.name); el.setAttribute('data-tp-cut', ''); }
      } else if ((FETCH_ATTRS.test(n) || (n === 'href' && !/^(a|area)$/i.test(el.localName))) && !ok(a.value)) {
        if (n !== 'ping') blocked++;
        el.removeAttribute(a.name);
        el.setAttribute('data-tp-cut', '');
      }
    }
    // Lazy pictures would never load in a hidden frame.
    if (el.getAttribute('loading') === 'lazy') el.removeAttribute('loading');
  }
  if (blocked) d.documentElement.setAttribute('data-tp-blocked', blocked);
  const head = d.head;
  if (base) head.prepend(Object.assign(d.createElement('base'), { href: base }));
  const csp = d.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = cspFor(origin);
  head.prepend(csp);
  if (!d.querySelector('meta[charset]')) head.prepend(Object.assign(d.createElement('meta'), { charset: 'utf-8' }));
  return '<!DOCTYPE html>' + d.documentElement.outerHTML;
}

async function htmlOf(item) {
  if (item.html != null) return cleanHtml(item.html, item.base);
  const buf = await item.file.arrayBuffer();
  // Honour a declared charset; most files are UTF-8.
  const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
  const cs = head.match(/charset=["']?([\w-]+)/i)?.[1] || 'utf-8';
  let text;
  try { text = new TextDecoder(cs).decode(buf); } catch { text = new TextDecoder().decode(buf); }
  return cleanHtml(text);
}

async function htmlToPdf(item, pdf, font, progress, s) {
  await lib('canvas');
  const long = s.size === 'long';
  const [PW, PH] = long ? SIZES.a4 : pageSize(s, false);
  const cw = (PW - 2 * s.margin) / PX, ch = (PH - 2 * s.margin) / PX;
  const fr = await frame(Math.round(cw), Math.round(ch), await htmlOf(item));
  try {
    const doc = fr.contentDocument;
    doc.head.append(Object.assign(doc.createElement('style'), { textContent: NO_BARS }));
    await settle(doc);
    const root = doc.documentElement;
    // Pages made for wide screens are shrunk to fit, not cut off.
    const lw = Math.max(cw, root.scrollWidth);
    const k = (cw / lw) * PX;
    const total = Math.max(root.scrollHeight, doc.body?.scrollHeight || 0);
    const avail = long ? (MAX_PAGE - 2 * s.margin) / k : ch * PX / k;
    const pages = breaks(total, avail, solids(root, 0), long ? [] : forcedBreaks(root, 0));
    for (const [i, [y0, y1]] of pages.entries()) {
      progress(i + 1, pages.length);
      const page = pdf.addPage(long ? [PW, (y1 - y0) * k + 2 * s.margin] : [PW, PH]);
      // The same pixels per point however far the page is shrunk (paint also caps the canvas).
      await paint(pdf, page, root, { y0, y1, w: lw, left: s.margin, top: s.margin, k, scale: Math.max(1, SCALE / PX * k) });
      addWords(page, font, wordsIn(doc.body || root, (x, y) => y >= y0 && y < y1), { k, map: (x, y) => [s.margin + x * k, s.margin + (y - y0) * k] });
    }
    // Pictures taken out for linking to other websites are counted separately.
    const missing = [...doc.images].filter((im) => !im.naturalWidth && !im.hasAttribute('data-tp-cut')).length;
    const blocked = +root.getAttribute('data-tp-blocked') || 0;
    return [
      missing && `${missing} picture${missing > 1 ? 's' : ''} could not be loaded${item.base ? '' : ' (pictures next to an .html file can’t be reached; use a web address or a page saved as one file)'}.`,
      blocked && `${blocked} link${blocked > 1 ? 's' : ''} to pictures, styles or fonts on ${item.base ? 'other websites' : 'the web'} ${blocked > 1 ? 'were' : 'was'} left out, so nothing was fetched from ${item.base ? 'them' : 'it'}.`,
    ].filter(Boolean).join(' ') || null;
  } finally {
    fr.remove();
  }
}

const BLOCKED = 'That site doesn’t let other websites read its pages, so it can’t be fetched from here. Open the page in your browser, save it (Ctrl+S, or Share › Save to Files on a phone), and choose the saved .html file instead.';

async function fetchPage(text) {
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(text.trim()) ? text.trim() : 'https://' + text.trim()); } catch { throw new Error('That doesn’t look like a web address.'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Use a web address that starts with http:// or https://.');
  let res;
  try { res = await fetch(url, { credentials: 'omit', redirect: 'follow' }); } catch { throw new Error(BLOCKED); }
  if (!res.ok) throw new Error(`The site answered with error ${res.status}. Check the address and try again.`);
  if (!/html|xml|text\/plain/i.test(res.headers.get('content-type') || 'text/html')) throw new Error('That address isn’t a web page.');
  const html = await res.text();
  return { name: url.hostname.replace(/^www\./, '') + '.html', html, base: res.url || url.href, size: html.length };
}

// Asks for something in a dialog until it works or is cancelled.
async function ask({ title, okText, body, use }) {
  let err = '';
  let value = '';
  for (;;) {
    value = await modal({
      title, okText, wide: true,
      body: (m) => {
        const input = body(value);
        m.value = () => input.value;
        setTimeout(() => input.focus(), 30);
        return [input.parentNode ? input.parentNode : input, err && h('p', { class: 'small bad', role: 'alert' }, err)];
      },
    });
    if (value == null) return;
    try {
      if (!value.trim()) throw new Error('Nothing was entered.');
      busy('Fetching…');
      await use(value);
      busy(false);
      return;
    } catch (e) {
      busy(false);
      err = e.message;
    }
  }
}

const htmlToPdfTool = {
  id: 'html-to-pdf', keywords: 'web page website url html htm convert save', title: 'HTML to PDF', icon: 'tpHtml', color: '#e07a52', cat: 'convert',
  accept: { accept: '.html,.htm,.xhtml,text/html', test: (f) => /\.(x?html?)$/i.test(f.name) || f.type === 'text/html', label: 'saved web page' },
  action: 'Convert to PDF', busyText: 'Converting…', wide: true,
  desc: 'Turn a web page or HTML file into a PDF.',
  long: 'Turn an .html file, pasted HTML or a web address into PDF pages. Scripts on the page don’t run, so it is converted as it looks without them. Pages are drawn as sharp pictures with the words hidden behind them, so you can still search and copy the text.',
  dropExtra: (start) => [
    h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ask({
      title: 'Paste HTML', okText: 'Use this HTML',
      body: (v) => h('textarea', { class: 'field tp-paste', rows: 10, placeholder: '<h1>Hello</h1>', 'aria-label': 'HTML', spellcheck: 'false' }, v),
      use: async (html) => start([{ name: 'pasted.html', html, size: html.length }]),
    }) }, icon('tpPaste'), 'Paste HTML'),
    h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => ask({
      title: 'Web address', okText: 'Fetch page',
      body: (v) => {
        const input = h('input', { class: 'field', type: 'url', inputmode: 'url', placeholder: 'https://example.com/page', value: v, 'aria-label': 'Web address', onkeydown: (e) => e.key === 'Enter' && input.closest('.modal')?.querySelector('.btn--solid').click() });
        h('div', { class: 'tp-ask' }, input, h('p', { class: 'muted small' }, 'Your browser fetches the page directly. Many sites don’t allow this; if so, save the page as a file and choose it instead.'));
        return input;
      },
      use: async (text) => start([await fetchPage(text)]),
    }) }, icon('tpLink'), 'Web address'),
  ],
  async setup(ctx) {
    const item = ctx.items[0];
    const s = ctx.state = { size: 'a4', orient: 'portrait', margin: 28 };
    const view = h('iframe', { class: 'tp-htmlview', sandbox: '', title: 'Preview of ' + item.name, referrerpolicy: 'no-referrer' });
    ctx.main.append(h('div', { class: 'tp-file' }, h('span', { class: 'tp-doc tp-doc--sm', style: { '--tp': '#e07a52' } }, 'HTML'),
      h('div', { class: 'card__meta' }, h('strong', { title: item.name }, item.name), h('span', {}, item.base ? item.base : fmtSize(item.size || 0)))), view);
    const orient = orientField(s, false);
    ctx.side.append(
      field('Page size', segmented([['a4', 'A4'], ['letter', 'Letter'], ['long', 'One long page']], s.size, (v) => { s.size = v; orient.hidden = v === 'long'; })),
      orient, marginField(s));
    try { view.srcdoc = await htmlOf(item); } catch (err) { toast(err.message, 'bad'); }
  },
  async run(ctx) {
    const { files, notes } = await convertAll(ctx.items, true, 'page.pdf', (it, pdf, font, progress) => htmlToPdf(it, pdf, font, progress, ctx.state));
    return { files, title: 'Your PDF is ready', note: notes.join(' ') };
  },
};

export const TO_PDF = [wordToPdfTool, pptToPdfTool, excelToPdfTool, htmlToPdfTool];
