// AI Summarizer, Translate PDF, PDF Forms and Workflows.
// The two AI tools use the models built into Chrome (Summarizer, Translator,
// LanguageDetector), which run on this device. Nothing is sent anywhere.
import {
  h, icon, busy, toast, tick, PDFDocument, StandardFonts, rgb, degrees, loadLib, renderPage, baseName,
  pageFrame, boxAnchor, fontCanDraw, textAsPng, hexToRgb, registerIcons, download, uid,
} from '../core.js';
import { field, segmented, choiceCards, check, slider, fileHero, fileRow, pdfOut } from '../ui.js';
import { readPage, matchItems, dropOps, plan } from '../content.js';
// tools.js imports this file too, so these are only touched inside functions.
import { LEVELS, shrinkImages, stampWatermark, stampNumbers } from '../tools.js';

registerIcons({
  summarize: '<path d="M10 3 8.6 7.6 4 9l4.6 1.4L10 15l1.4-4.6L16 9l-4.6-1.4z"/><path d="M18 14v6"/><path d="M15 17h6"/><path d="M5 18h6"/>',
  translate: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  forms: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h4"/><rect x="7" y="11" width="10" height="3" rx="1"/><path d="m7 17.5 1.2 1.2L10.5 16"/><path d="M13 17.5h4"/>',
  workflow: '<rect x="3" y="3" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
  smCopy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  smWand: '<path d="m15 4 5 5L8 21l-5-5z"/><path d="m12 7 5 5"/><path d="M5 3v4M3 5h4M19 15v4M17 17h4"/>',
  smCheckbox: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  smRadio: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/>',
  smDropdown: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m14 11 2 2 2-2"/><path d="M7 12h4"/>',
  smUp: '<path d="m18 15-6-6-6 6"/>',
  smDown: '<path d="m6 9 6 6 6-6"/>',
  smInfo: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
});

/* ---------- reading text ---------- */

// pdf.js text items that run left to right in PDF space. Text on a page with
// /Rotate is still left to right here, so drawing in PDF space keeps it right.
const flat = (t) => t[0] > 0 && t[3] > 0 && Math.abs(t[1]) < 1e-3 * t[0] && Math.abs(t[2]) < 1e-3 * t[3];

// Groups text items into runs (one line of one column) and runs into
// paragraphs, so a sentence broken over three lines is read, and translated,
// as one. Each run keeps the indexes of its items, to take them off the page.
export function paragraphs(items) {
  const parts = [];
  items.forEach((it, j) => {
    const t = it.transform;
    if (it.str && it.str.trim() && flat(t)) parts.push({ j, str: it.str, x: t[4], y: t[5], s: t[3], right: t[4] + it.width });
  });
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const p of parts) {
    let row = null;
    for (let k = rows.length - 1; k >= 0 && rows[k].y - p.y < p.s * 2; k--) {
      if (Math.abs(rows[k].y - p.y) < Math.min(rows[k].s, p.s) * 0.35) { row = rows[k]; break; }
    }
    if (row) { row.parts.push(p); row.s = Math.max(row.s, p.s); } else rows.push({ y: p.y, s: p.s, parts: [p] });
  }
  const runs = [];
  for (const row of rows) {
    row.parts.sort((a, b) => a.x - b.x);
    let run = null;
    for (const p of row.parts) {
      const gap = run ? p.x - run.right : Infinity;
      if (gap > p.s * 0.8) { // a wide gap: the next column or table cell
        run = { x: p.x, right: p.right, y: row.y, s: p.s, text: p.str, js: [p.j] };
        runs.push(run);
        continue;
      }
      if (gap > p.s * 0.12 && !/\s$/.test(run.text) && !/^\s/.test(p.str)) run.text += ' ';
      run.text += p.str;
      run.right = Math.max(run.right, p.right);
      run.s = Math.max(run.s, p.s);
      run.js.push(p.j);
    }
  }
  runs.forEach((r) => (r.text = r.text.replace(/\s+/g, ' ').trim()));
  const paras = [];
  for (const r of runs) {
    let best = null, bestD = Infinity;
    for (const p of paras) {
      const last = p.runs[p.runs.length - 1];
      const d = last.y - r.y;
      if (d <= r.s * 0.5 || d > Math.max(r.s, last.s) * 1.9) continue;
      if (Math.abs(r.s - last.s) > last.s * 0.15) continue; // a heading and its text stay apart
      if (Math.abs(r.x - last.x) > r.s * 2 && Math.abs(r.x - p.x) > r.s * 2) continue;
      if (last.right < r.right - r.s * 4) continue; // a short line ends its paragraph
      if (d < bestD) { best = p; bestD = d; }
    }
    if (best) { best.runs.push(r); best.x = Math.min(best.x, r.x); best.right = Math.max(best.right, r.right); }
    else paras.push({ runs: [r], x: r.x, right: r.right, s: r.s });
  }
  for (const p of paras) {
    p.text = p.runs.reduce((acc, r) => (!acc ? r.text : /\p{L}-$/u.test(acc) && /^\p{Ll}/u.test(r.text) ? acc.slice(0, -1) + r.text : acc + ' ' + r.text), '');
    p.js = p.runs.flatMap((r) => r.js);
  }
  return paras;
}

async function docParagraphs(doc, onPage) {
  const out = [];
  for (let i = 0; i < doc.pages; i++) {
    onPage?.(i);
    const page = await doc.js.getPage(i + 1);
    const tc = await page.getTextContent();
    paragraphs(tc.items.filter((it) => typeof it.str === 'string')).forEach((p) => out.push({ ...p, page: i }));
    page.cleanup();
  }
  return out;
}

// Line breaking for any script: Intl.Segmenter knows where words end in
// Chinese, Japanese and Thai, which have no spaces.
function wrap(text, maxW, measure, lang) {
  let tokens;
  try { tokens = [...new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)].map((s) => s.segment); } catch { tokens = text.split(/(\s+)/); }
  const lines = [];
  let cur = '';
  for (const t of tokens) {
    const next = cur + t;
    if (cur.trim() && measure(next.trimEnd()) > maxW) { lines.push(cur.trimEnd()); cur = t.trimStart(); } else cur = next;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

// Width of text as textAsPng() will draw it, in points.
const measurer = document.createElement('canvas').getContext('2d');
function pngWidth(text, size, family, bold) {
  measurer.font = `${bold ? '700' : '400'} ${size * 4}px ${family}`;
  return measurer.measureText(text).width / 4 + size * 0.2;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const firstStrongRtl = (s) => { const m = s.match(/\p{L}/u); return !!m && RTL.test(m[0]); };
// Keeps full stops and numbers on the correct side of right-to-left lines.
const isolate = (s) => (firstStrongRtl(s) ? '⁧' + s + '⁩' : s);

const CSS_FONTS = { Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };
const STD = { Helvetica: ['Helvetica', 'HelveticaBold'], Times: ['TimesRoman', 'TimesRomanBold'], Courier: ['Courier', 'CourierBold'] };

/* ---------- Chrome's built-in AI ---------- */

// 'available', 'downloadable', 'downloading', 'unavailable', or 'missing' when
// this browser has no such API at all.
async function aiState(api, opts) {
  const A = self[api];
  if (!A?.availability) return 'missing';
  try { return await A.availability(opts); } catch { return 'unavailable'; }
}
const progress = (label) => (m) => m.addEventListener('downloadprogress', (e) => busy(`${label} ${Math.round((e.loaded ?? 0) * 100)}%`));

function statusBox(kind, title, text) {
  return h('div', { class: `sm-status sm-status--${kind}`, role: 'status' },
    icon(kind === 'ok' ? 'check' : kind === 'wait' ? 'download' : 'smInfo'),
    h('div', {}, h('strong', {}, title), text && h('p', {}, text)));
}

const SUM_NEEDS = 'It needs Chrome 138 or newer on a computer (Windows 10 or 11, macOS 13+, Linux or a Chromebook Plus) with about 22 GB of free disk space, and either a graphics card with more than 4 GB of memory or 16 GB of RAM. It is not in other browsers or on phones yet.';
const TR_NEEDS = 'It needs Chrome 138 or newer on a computer (Windows, macOS, Linux or ChromeOS). It is not in other browsers or on phones yet. Your file never leaves this device, so there is no online fallback.';

/* ---------- AI SUMMARIZER ---------- */

const TYPES = [['key-points', 'Key points'], ['tldr', 'TL;DR'], ['teaser', 'Teaser'], ['headline', 'Headline']];
const LENGTHS = [['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']];

const summarize = {
  id: 'summarize', title: 'AI Summarizer', icon: 'summarize', color: '#8b5cf6', cat: 'ai', action: 'Summarize', busyText: 'Reading the PDF…',
  keywords: 'summary summarise ai tldr key points digest gemini nano',
  desc: 'Get the key points of a long PDF in seconds.',
  long: 'Key points, a TL;DR, a teaser or a headline for any PDF with text. Uses the AI built into Chrome, on this device.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { type: 'key-points', length: 'medium', method: 'ai', ai: 'checking', result: null };
    s.out = h('div', { class: 'sm-sum' },
      h('div', { class: 'sm-sum__empty' }, fileRow(doc), h('p', { class: 'muted' }, 'Your summary will show up here. Pick a style, then press Summarize.')));
    const status = h('div', {});
    const method = h('div', {});
    const draw = () => {
      const a = s.ai;
      if (a === 'checking') status.replaceChildren(statusBox('wait', 'Checking Chrome’s built-in AI…'));
      else if (a === 'available') status.replaceChildren(statusBox('ok', 'Chrome’s on-device AI is ready', 'The summary is written on this device.'));
      else if (a === 'downloadable' || a === 'downloading') status.replaceChildren(statusBox('wait', 'Chrome will download its AI model', 'Once, when you start. It can take a few minutes; after that it works offline.'));
      else status.replaceChildren(statusBox('bad', 'Chrome’s built-in AI is not available here', SUM_NEEDS + ' Quick extract works in any browser.'));
      const ai = !['missing', 'unavailable', 'checking'].includes(a);
      s.method = ai ? s.picked || 'ai' : 'local';
      method.replaceChildren(field('Method', choiceCards([
        ...(ai ? [['ai', 'Chrome AI', 'Writes a new summary, on this device']] : []),
        ['local', 'Quick extract', 'Picks the most telling sentences. Works in any browser'],
      ], s.method, (v) => (s.method = s.picked = v))));
    };
    const refresh = async () => { s.ai = await aiState('Summarizer', { type: s.type, format: 'markdown', length: s.length }); draw(); };
    ctx.main.append(s.out);
    ctx.side.append(
      status, method,
      field('Style', segmented(TYPES, s.type, (v) => { s.type = v; refresh(); })),
      field('Length', segmented(LENGTHS, s.length, (v) => { s.length = v; refresh(); })));
    draw();
    refresh();
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    // Chrome only starts a model download right after a click, so ask first.
    const sm = s.method === 'ai' ? await newSummarizer({ type: s.type, length: s.length }, doc.name) : null;
    let md;
    try {
      const paras = await docParagraphs(doc, (i) => busy(`Reading page ${i + 1} of ${doc.pages}…`));
      if (!paras.some((p) => /\p{L}{2}/u.test(p.text))) throw new Error('This PDF has no text to summarize. If it is a scan, run OCR on it first.');
      if (sm) md = await aiSummary(paras, sm, doc.name);
      else { busy('Picking the key sentences…'); await tick(); md = extractive(paras, s.type, s.length); }
    } finally { sm?.destroy?.(); }
    s.result = { md, type: s.type, length: s.length, method: s.method };
    showSummary(ctx);
    ctx.action.firstChild.textContent = 'Summarize again';
  },
};

function showSummary(ctx) {
  const doc = ctx.items[0];
  const { md, type, length, method } = ctx.state.result;
  const base = baseName(doc.name);
  const meta = `${TYPES.find((t) => t[0] === type)[1]} · ${LENGTHS.find((l) => l[0] === length)[1]} · ${method === 'ai' ? 'Chrome on-device AI' : 'Quick extract'}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(md); toast('Summary copied.'); } catch { toast('Could not copy. Select the text and copy it instead.', 'bad'); }
  };
  const pdf = async () => {
    busy('Making the PDF…');
    try { download(await summaryPdf(md, { title: `Summary of ${doc.name}`, meta }), `${base}-summary.pdf`); } finally { busy(false); }
  };
  ctx.state.out.replaceChildren(h('article', { class: 'sm-sum__card' },
    h('div', { class: 'sm-sum__head' },
      h('div', {}, h('h2', {}, 'Summary'), h('p', { class: 'muted small' }, meta)),
      h('div', { class: 'sm-sum__acts' },
        h('button', { class: 'btn btn--soft', onclick: copy }, icon('smCopy'), 'Copy'),
        h('button', { class: 'btn btn--soft', 'data-get': 'md', onclick: () => download(new Blob([md], { type: 'text/markdown' }), `${base}-summary.md`) }, icon('download'), 'Markdown'),
        h('button', { class: 'btn btn--soft', 'data-get': 'pdf', onclick: pdf }, icon('download'), 'PDF'))),
    h('div', { class: 'sm-md', dir: 'auto' }, mdNodes(md)),
    method === 'local' && h('p', { class: 'muted small sm-sum__foot' }, 'Quick extract quotes sentences from the PDF word for word. Chrome AI writes a new summary.')));
  ctx.state.out.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function newSummarizer(opts, name) {
  const lang = ['en', 'es', 'ja'].includes(navigator.language?.slice(0, 2)) ? navigator.language.slice(0, 2) : 'en';
  const all = { ...opts, format: 'markdown', sharedContext: `Text from a PDF document named “${name}”.`, monitor: progress('Downloading Chrome’s AI model…') };
  busy('Starting Chrome’s AI…');
  try { return await self.Summarizer.create({ ...all, expectedInputLanguages: ['en', 'es', 'ja'], outputLanguage: lang }); } catch (err) {
    if (err?.name === 'NotAllowedError') throw new Error('Chrome needs a click to start downloading its AI model. Press Summarize again.');
    return self.Summarizer.create(all); // older Chrome without the language options
  }
}

// Long documents don't fit the model in one go: summarize parts, then
// summarize those summaries, until everything fits.
async function aiSummary(paras, final, name) {
  let part = null;
  const fits = async (sm, text) => {
    const quota = sm.inputQuota;
    if (!quota || !isFinite(quota) || !sm.measureInputUsage) return text.length < 12000;
    return (await sm.measureInputUsage(text)) <= quota * 0.9;
  };
  try {
    let pieces = paras.map((p) => p.text);
    for (let round = 1; ; round++) {
      const whole = pieces.join('\n\n');
      if (await fits(final, whole)) { busy('Writing the summary…'); return (await final.summarize(whole)).trim(); }
      part ||= await newSummarizer({ type: 'key-points', length: 'long' }, name);
      const chunks = await pack(pieces, (t) => fits(part, t));
      if (round > 4 || (round > 1 && chunks.length >= pieces.length)) throw new Error('This PDF is too long for Chrome’s AI. Try Quick extract.');
      const next = [];
      for (const [k, c] of chunks.entries()) {
        busy(`Summarizing part ${k + 1} of ${chunks.length}…`);
        next.push((await part.summarize(c)).trim());
      }
      pieces = next;
    }
  } finally { part?.destroy?.(); }
}

// Joins pieces into as few chunks as fit; splits a piece too big on its own.
async function pack(pieces, fits) {
  const chunks = [];
  let cur = '';
  const queue = [...pieces];
  while (queue.length) {
    const p = queue.shift();
    const next = cur ? cur + '\n\n' + p : p;
    if (await fits(next)) { cur = next; continue; }
    if (cur) { chunks.push(cur); cur = ''; queue.unshift(p); continue; }
    const sents = sentences(p);
    if (sents.length > 1) { const mid = Math.ceil(sents.length / 2); queue.unshift(sents.slice(0, mid).join(' '), sents.slice(mid).join(' ')); }
    else { const mid = Math.ceil(p.length / 2); queue.unshift(p.slice(0, mid), p.slice(mid)); }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function sentences(text) {
  try { return [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)].map((s) => s.segment.trim()).filter(Boolean); } catch {
    return text.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  }
}

const STOP = new Set('a an and are as at be been but by can could did do does for from had has have he her his i if in into is it its may more most must no not of on or our she should so than that the their them then there these they this those to us was we were what when which who will with would you your also such any all each other only over very just about after before between both during through under while being where why how'.split(' '));

// Quick extract: scores each sentence by the document's characteristic words
// it holds (TF-IDF), adds a little for opening sentences, and quotes the best
// ones in their original order.
export function extractive(paras, type, length) {
  const list = [];
  paras.forEach((p, pi) => sentences(p.text).forEach((t, k) => list.push({ t, pi, k })));
  const words = (t) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => (w.length > 2 || /[^\u0000-ɏ]/.test(w)) && !STOP.has(w) && !/^\d+$/.test(w));
  list.forEach((s) => (s.w = words(s.t)));
  const usable = list.filter((s) => s.w.length >= 3);
  const pool = usable.length ? usable : list.filter((s) => s.w.length);
  if (!pool.length) return '';
  const df = new Map(), tf = new Map();
  pool.forEach((s) => { new Set(s.w).forEach((w) => df.set(w, (df.get(w) || 0) + 1)); s.w.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1)); });
  const N = pool.length;
  const weight = (w) => Math.log(1 + tf.get(w)) * (Math.log((N + 1) / (df.get(w) + 0.5)) + 1);
  pool.forEach((s, idx) => {
    const uniq = [...new Set(s.w)];
    let score = uniq.reduce((a, w) => a + weight(w), 0) / Math.sqrt(Math.max(uniq.length, 4));
    if (idx === 0) score *= 1.35;
    else if (s.k === 0) score *= 1.15;
    if (s.w.length > 45) score *= 0.75;
    if (!/[.!?。！？؟]["”’)]?$/.test(s.t)) score *= 0.7; // headings, captions, table rows
    s.score = score;
    s.idx = idx;
  });
  const want = { headline: 1, teaser: 2, tldr: { short: 2, medium: 3, long: 5 }[length], 'key-points': { short: 3, medium: 5, long: 8 }[length] }[type];
  const n = Math.max(1, Math.min(want, Math.ceil(N / (type === 'key-points' ? 2 : 3))));
  const sim = (a, b) => { const A = new Set(a.w), B = new Set(b.w); let c = 0; A.forEach((w) => B.has(w) && c++); return c / Math.max(1, Math.min(A.size, B.size)); };
  const picked = [];
  for (const s of [...pool].sort((a, b) => b.score - a.score)) {
    if (picked.length >= n) break;
    if (!picked.some((p) => sim(p, s) > 0.6)) picked.push(s); // say each thing once
  }
  if (type === 'headline') {
    // A big title on the first page beats any sentence.
    const sizes = paras.map((p) => p.s).sort((a, b) => a - b);
    const body = sizes[Math.floor(sizes.length / 2)] || 0;
    const title = paras.find((p) => !p.page && p.s > body * 1.25 && p.text.split(/\s+/).length <= 16);
    return '**' + (title ? title.text : picked[0].t).replace(/\*/g, '') + '**';
  }
  picked.sort((a, b) => a.idx - b.idx);
  return type === 'key-points' ? picked.map((s) => '- ' + s.t).join('\n') : picked.map((s) => s.t).join(' ');
}

/* ---------- a little markdown ---------- */

export function mdBlocks(md) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push({ kind: 'p', text: para.join(' ') }); para = []; };
  for (const raw of String(md).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) flush();
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); out.push({ kind: 'h', level: m[1].length, text: m[2] }); }
    else if ((m = line.match(/^[-*•+]\s+(.*)$/))) { flush(); out.push({ kind: 'li', text: m[1] }); }
    else if ((m = line.match(/^(\d+)[.)]\s+(.*)$/))) { flush(); out.push({ kind: 'li', n: m[1], text: m[2] }); }
    else para.push(line);
  }
  flush();
  return out;
}

// **bold**, *italic*, _italic_ and `code` -> [{ text, bold, italic }]
export function mdInline(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__|(?<![\p{L}\p{N}*])\*(?!\s)(.+?)\*|(?<![\p{L}\p{N}_])_(?!\s)(.+?)_(?![\p{L}\p{N}])|`(.+?)`/gu;
  let at = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5], bold: !!(m[1] || m[2]), italic: !!(m[3] || m[4]) });
    at = re.lastIndex;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

function mdNodes(md) {
  const inline = (t) => mdInline(t).map((r) => (r.bold ? h('strong', {}, r.text) : r.italic ? h('em', {}, r.text) : r.text));
  const nodes = [];
  let list = null;
  for (const b of mdBlocks(md)) {
    if (b.kind === 'li') {
      const tag = b.n ? 'OL' : 'UL';
      if (list?.tagName !== tag) { list = h(tag.toLowerCase(), {}); nodes.push(list); }
      list.append(h('li', {}, inline(b.text)));
      continue;
    }
    list = null;
    nodes.push(b.kind === 'h' ? h(`h${Math.min(6, b.level + 2)}`, {}, inline(b.text)) : h('p', {}, inline(b.text)));
  }
  return nodes;
}

// A clean A4 PDF of the summary. Letters the standard fonts lack (Urdu,
// Chinese…) are drawn by the browser, a line at a time.
async function summaryPdf(md, { title, meta }) {
  const pdf = await PDFDocument.create();
  const F = { r: await pdf.embedFont(StandardFonts.Helvetica), b: await pdf.embedFont(StandardFonts.HelveticaBold), i: await pdf.embedFont(StandardFonts.HelveticaOblique) };
  const W = 595.28, H = 841.89, M = 60;
  let page, y;
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  newPage();
  // Writes inline runs wrapped to the margin; returns where its first line went.
  const write = async (runs, { x = M, size = 11, color = '#17173a', lh = 1.5, bold = false } = {}) => {
    const width = W - M - x;
    const fontOf = (r) => (r.bold || bold ? F.b : r.italic ? F.i : F.r);
    let first = null;
    const line = () => {
      if (y - size * lh < M) newPage();
      const base = y - size;
      first ??= { page, base };
      y -= size * lh;
      return base;
    };
    if (runs.every((r) => fontCanDraw(fontOf(r), r.text))) {
      const lines = [[]];
      let w = 0;
      for (const r of runs) {
        for (const t of r.text.split(/(\s+)/).filter(Boolean)) {
          const f = fontOf(r);
          const tw = f.widthOfTextAtSize(t, size);
          const cur = lines.at(-1);
          if (/^\s+$/.test(t)) { if (cur.length) { cur.push({ t: ' ', f }); w += f.widthOfTextAtSize(' ', size); } continue; }
          if (w + tw > width && cur.length) {
            while (cur.length && cur.at(-1).t === ' ') cur.pop();
            lines.push([]); w = 0;
          }
          lines.at(-1).push({ t, f });
          w += tw;
        }
      }
      for (const ln of lines) {
        const base = line();
        let cx = x;
        for (const tk of ln) { page.drawText(tk.t, { x: cx, y: base, size, font: tk.f, color: hexToRgb(color) }); cx += tk.f.widthOfTextAtSize(tk.t, size); }
      }
    } else {
      const plain = runs.map((r) => r.text).join('');
      for (const ln of wrap(plain, width, (t) => pngWidth(t, size, CSS_FONTS.Helvetica, bold))) {
        const base = line();
        const png = await textAsPng(isolate(ln), { size, color, bold });
        const k = Math.min(1, width / png.width);
        page.drawImage(await pdf.embedPng(png.bytes), { x: firstStrongRtl(ln) ? W - M - png.width * k : x - size * 0.1, y: base - size * 0.3, width: png.width * k, height: png.height * k });
      }
    }
    return first;
  };
  await write([{ text: title }], { size: 19, bold: true, lh: 1.3 });
  y -= 2;
  await write([{ text: meta + ' · ' + new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) }], { size: 9.5, color: '#646a8a' });
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: hexToRgb('#d9d0fc') });
  y -= 16;
  for (const b of mdBlocks(md)) {
    if (b.kind === 'h') { y -= 6; await write(mdInline(b.text), { size: b.level <= 1 ? 15 : 13, bold: true, lh: 1.35 }); y -= 2; }
    else if (b.kind === 'li') {
      const at = await write(mdInline(b.text), { x: M + 16 });
      if (at) at.page.drawText(b.n ? b.n + '.' : '•', { x: M + 2, y: at.base, size: 11, font: F.b, color: hexToRgb('#6646e8') });
      y -= 5;
    } else { await write(mdInline(b.text)); y -= 8; }
  }
  return pdf.save();
}

/* ---------- TRANSLATE PDF ---------- */

const LANGS = [
  ['ar', 'Arabic'], ['bn', 'Bengali'], ['zh', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'], ['cs', 'Czech'], ['da', 'Danish'],
  ['nl', 'Dutch'], ['en', 'English'], ['fi', 'Finnish'], ['fr', 'French'], ['de', 'German'], ['el', 'Greek'], ['he', 'Hebrew'], ['hi', 'Hindi'],
  ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['fa', 'Persian'], ['pl', 'Polish'],
  ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'], ['es', 'Spanish'], ['sv', 'Swedish'], ['th', 'Thai'], ['tr', 'Turkish'],
  ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['vi', 'Vietnamese'],
];
const langName = (code) => LANGS.find((l) => l[0] === code)?.[1] || code;

const translate = {
  id: 'translate', title: 'Translate PDF', icon: 'translate', color: '#0ea5e9', cat: 'ai', action: 'Translate PDF', busyText: 'Getting ready…',
  keywords: 'translation translator language urdu arabic spanish french german chinese hindi',
  desc: 'Translate a PDF and keep its layout.',
  long: 'Translate the text of a PDF into another language. The translation goes where the original text was. Uses the translator built into Chrome, on this device.',
  setup(ctx) {
    const doc = ctx.items[0];
    const mine = navigator.language?.split('-')[0];
    const s = ctx.state = { source: 'auto', detected: null, target: mine && mine !== 'en' && LANGS.some((l) => l[0] === mine) ? mine : 'es' };
    const status = h('div', {});
    const scans = h('div', {});
    ctx.main.append(fileHero(doc), scans);
    if (!self.Translator?.create) {
      ctx.side.append(statusBox('bad', 'Translating needs Chrome’s built-in translator', TR_NEEDS));
      ctx.action.disabled = true;
      return;
    }
    const options = (withAuto) => [withAuto && h('option', { value: 'auto' }, 'Detect automatically'), ...LANGS.map(([v, n]) => h('option', { value: v }, n))];
    const src = h('select', { class: 'field', 'aria-label': 'From', onchange: (e) => { s.source = e.target.value; refresh(); } }, options(true));
    const tgt = h('select', { class: 'field', 'aria-label': 'To', onchange: (e) => { s.target = e.target.value; refresh(); } }, options(false));
    tgt.value = s.target;
    const detected = h('p', { class: 'muted small' });
    let noText = false;
    const refresh = async () => {
      const from = s.source === 'auto' ? s.detected : s.source;
      detected.textContent = s.source === 'auto' ? (s.detected ? `Looks like ${langName(s.detected)}.` : 'The language is detected when you start.') : '';
      ctx.action.disabled = noText;
      if (!from) { status.replaceChildren(); return; }
      if (from === s.target) { status.replaceChildren(statusBox('bad', `The PDF is already in ${langName(from)}`, 'Pick another language to translate into.')); ctx.action.disabled = true; return; }
      const state = await aiState('Translator', { sourceLanguage: from, targetLanguage: s.target });
      status.replaceChildren(state === 'available' ? statusBox('ok', 'Ready, on this device')
        : state === 'unavailable' ? statusBox('bad', `Chrome can’t translate ${langName(from)} to ${langName(s.target)} yet`, 'Try another pair of languages.')
          : statusBox('wait', 'Chrome will download this language pack', 'Once, when you start. After that it works offline.'));
      ctx.action.disabled = noText || state === 'unavailable';
    };
    ctx.side.append(
      field('From', src), detected,
      field('To', tgt),
      status,
      h('p', { class: 'muted small' }, 'The translation goes where the original text was, in a smaller size when it runs longer. Text in pictures and scans stays as it is.'));
    refresh();
    // Look for scanned pages and the language while the person picks.
    (async () => {
      const paras = await docParagraphs(doc);
      const withText = new Set(paras.filter((p) => /\p{L}/u.test(p.text)).map((p) => p.page));
      const empty = [...Array(doc.pages).keys()].filter((i) => !withText.has(i)).map((i) => i + 1);
      s.sample = paras.map((p) => p.text).join(' ').slice(0, 3000);
      if (empty.length) {
        const all = empty.length === doc.pages, many = empty.length > 1;
        scans.replaceChildren(h('p', { class: 'sm-note' }, icon('smInfo'), all
          ? 'This PDF has no text to translate. It is probably a scan: run OCR on it first, then translate the result.'
          : `Page${many ? 's' : ''} ${empty.join(', ')} ${many ? 'have' : 'has'} no text (probably scanned) and will stay as ${many ? 'they are' : 'it is'}. Run OCR first to translate ${many ? 'them' : 'it'}.`));
        noText = all;
      }
      if (!noText && (await aiState('LanguageDetector')) === 'available') s.detected = await detectLang(s.sample).catch(() => null);
      refresh();
    })().catch((err) => console.warn(err));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    let from = s.source === 'auto' ? s.detected : s.source;
    if (!from) {
      if ((await aiState('LanguageDetector')) === 'missing') throw new Error('Pick the language the PDF is in, under “From”.');
      busy('Detecting the language…');
      s.sample ??= (await docParagraphs(doc)).map((p) => p.text).join(' ').slice(0, 3000);
      from = await detectLang(s.sample);
      if (!from) throw new Error('Could not tell which language this PDF is in. Pick it under “From”.');
    }
    if (from === s.target) throw new Error(`This PDF is already in ${langName(from)}. Pick another language.`);
    const state = await aiState('Translator', { sourceLanguage: from, targetLanguage: s.target });
    if (state === 'unavailable' || state === 'missing') throw new Error(`Chrome can’t translate ${langName(from)} to ${langName(s.target)} yet.`);
    busy('Getting the translator ready…');
    let tr;
    try {
      tr = await self.Translator.create({ sourceLanguage: from, targetLanguage: s.target, monitor: progress('Downloading the language pack…') });
    } catch (err) {
      if (err?.name === 'NotAllowedError') throw new Error('Chrome needs a click to download the language pack. Press Translate PDF again.');
      throw err;
    }
    try {
      const lib = await loadLib(doc);
      let done = 0, skipped = 0;
      for (let i = 0; i < doc.pages; i++) {
        busy(`Translating page ${i + 1} of ${doc.pages}…`);
        const r = await translatePage(doc, lib, i, tr, s.target);
        done += r.done;
        skipped += r.skipped;
      }
      if (!done) throw new Error('Nothing was translated. The PDF may have no text, or it is already in that language.');
      busy('Saving…');
      return {
        files: [pdfOut(`${baseName(doc.name)}-${s.target}.pdf`, await lib.save())],
        title: `Translated to ${langName(s.target)}`,
        note: `${done} block${done > 1 ? 's' : ''} of text translated from ${langName(from)}.` + (skipped ? ` ${skipped} piece${skipped > 1 ? 's' : ''} of turned or slanted text stayed as ${skipped > 1 ? 'they were' : 'it was'}.` : ''),
      };
    } finally { tr.destroy?.(); }
  },
};

async function detectLang(text) {
  const det = await self.LanguageDetector.create({ monitor: progress('Downloading the language detector…') });
  try {
    const [best] = await det.detect(text);
    return best && best.confidence > 0.4 && best.detectedLanguage !== 'und' ? best.detectedLanguage : null;
  } finally { det.destroy?.(); }
}

// Translates one page in place: takes each paragraph's drawing commands out
// (content.js, as Edit PDF does) and draws the translation in the same box.
async function translatePage(doc, lib, i, tr, target) {
  const jsPage = await doc.js.getPage(i + 1);
  const tc = await jsPage.getTextContent();
  await jsPage.getOperatorList(); // makes the fonts' real names available
  const items = tc.items.filter((it) => typeof it.str === 'string');
  items.forEach((it) => {
    let name = '';
    try { name = jsPage.commonObjs.get(it.fontName)?.name || ''; } catch { /* not loaded */ }
    const family = tc.styles[it.fontName]?.fontFamily;
    it.font = /times|roman|georgia|garamond|cambria|minion|antiqua|bookman|palatino/i.test(name) || family === 'serif' ? 'Times'
      : /courier|mono|consol/i.test(name) || family === 'monospace' ? 'Courier' : 'Helvetica';
    it.bold = /bold|black|heavy|semibold|demi/i.test(name);
  });
  jsPage.cleanup();
  const skipped = items.filter((it) => /\p{L}/u.test(it.str) && !flat(it.transform)).length;
  const work = [];
  for (const p of paragraphs(items)) {
    if (!/\p{L}/u.test(p.text)) continue; // numbers alone stay as they are
    const out = (await translateText(tr, p.text)).replace(/\s+/g, ' ').trim();
    if (out && out !== p.text) work.push({ p, out }); // names and codes often come back the same: leave them
  }
  if (!work.length) return { done: 0, skipped };

  let read = null;
  try { read = readPage(lib, i); matchItems(items, read.shows); } catch (err) {
    console.warn('content stream', err);
    read = null;
    items.forEach((it) => { it.own = []; it.parent = -1; it.color = '#000000'; });
  }
  const { drop, redraw, cover } = plan(items, new Set(work.flatMap((w) => w.p.js)));
  if (read && drop.size) dropOps(lib, read, drop);
  const page = lib.getPage(i);
  const fonts = new Map();
  const fontFor = async (it) => {
    const key = STD[it.font][it.bold ? 1 : 0];
    if (!fonts.has(key)) fonts.set(key, await lib.embedFont(StandardFonts[key]));
    return fonts.get(key);
  };
  for (const j of cover) { // text whose command we couldn't find (e.g. inside a form XObject)
    const it = items[j], t = it.transform;
    page.drawRectangle({ x: t[4] - 1, y: t[5] - t[3] * 0.25, width: it.width + 2, height: t[3] * 1.2, color: rgb(1, 1, 1) });
  }
  for (const j of redraw) { // neighbours that shared a command with translated text
    const it = items[j];
    if (!it.str) continue;
    const t = it.transform, sz = Math.hypot(t[2], t[3]);
    const rotate = degrees((Math.atan2(t[1], t[0]) * 180) / Math.PI);
    const fnt = await fontFor(it);
    if (fontCanDraw(fnt, it.str)) page.drawText(it.str, { x: t[4], y: t[5], size: sz, font: fnt, color: hexToRgb(it.color), rotate });
    else {
      const png = await textAsPng(it.str, { family: CSS_FONTS[it.font], bold: it.bold, size: sz, color: it.color, lineHeight: 1.2 });
      page.drawImage(await lib.embedPng(png.bytes), { x: t[4], y: t[5] - sz * 0.3, width: png.width, height: png.height, rotate });
    }
  }
  for (const { p, out } of work) {
    const first = items[p.runs[0].js[0]];
    await drawBlock(lib, page, p, out, first, await fontFor(first), target);
  }
  return { done: work.length, skipped };
}

// Long paragraphs go to the translator a few sentences at a time.
async function translateText(tr, text) {
  if (text.length <= 1500) return tr.translate(text);
  const parts = [];
  let cur = '';
  for (const s of sentences(text)) {
    if (cur && cur.length + s.length > 1200) { parts.push(cur); cur = ''; }
    cur += (cur ? ' ' : '') + s;
  }
  if (cur) parts.push(cur);
  const out = [];
  for (const p of parts) out.push(await tr.translate(p));
  return out.join(' ');
}

// Draws translated text in the original paragraph's box: same left edge,
// first baseline and line spacing; the font shrinks until the text fits.
async function drawBlock(lib, page, p, text, first, font, lang) {
  const s = p.s;
  const n = p.runs.length;
  const width = Math.max(p.right - p.x, s * 2);
  const step = n > 1 ? (p.runs[0].y - p.runs[n - 1].y) / (n - 1) : s * 1.2;
  const std = fontCanDraw(font, text);
  const family = CSS_FONTS[first.font];
  const measure = (t, z) => (std ? font.widthOfTextAtSize(t, z) : pngWidth(t, z, family, first.bold));
  let z = s, lines = [text];
  if (n === 1) z = Math.max(s * 0.35, Math.min(s, (s * width) / measure(text, s)));
  else {
    for (;;) {
      lines = wrap(text, width, (t) => measure(t, z), lang);
      if (lines.length <= Math.floor((n * s) / z + 0.01) || z < s * 0.45) break;
      z *= 0.93;
    }
  }
  const color = first.color || '#000000';
  const lineStep = step * (z / s);
  for (const [k, line] of lines.entries()) {
    const base = p.runs[0].y - k * lineStep;
    if (std) { page.drawText(line, { x: p.x, y: base, size: z, font, color: hexToRgb(color) }); continue; }
    const png = await textAsPng(isolate(line), { family, bold: first.bold, size: z, color, lineHeight: 1.25 });
    const k2 = Math.min(1, (width * 1.03) / png.width);
    const w = png.width * k2, hh = png.height * k2;
    page.drawImage(await lib.embedPng(png.bytes), {
      x: firstStrongRtl(line) ? p.x + width - w : p.x - z * 0.1 * k2,
      y: base - z * 0.3 + (png.height - hh) / 2, width: w, height: hh,
    });
  }
}

/* ---------- PDF FORMS ---------- */

const NEW_KINDS = [ // type, label, icon, default size in points
  ['text', 'Text', 'text', { w: 170, h: 20 }],
  ['check', 'Checkbox', 'smCheckbox', { w: 14, h: 14 }],
  ['select', 'Dropdown', 'smDropdown', { w: 130, h: 20 }],
  ['radio', 'Choice', 'smRadio', { w: 14, h: 14 }],
  ['sig', 'Signature', 'sign', { w: 190, h: 42 }],
];
const kindInfo = (k) => NEW_KINDS.find((x) => x[0] === k);
const square = (t) => t === 'check' || t === 'radio';

const forms = {
  id: 'forms', title: 'PDF Forms', icon: 'forms', color: '#a16207', cat: 'edit', action: 'Save PDF', busyText: 'Saving…', wide: true,
  keywords: 'fill form fillable fields acroform checkbox dropdown create form',
  desc: 'Fill in a PDF form, or make any PDF fillable.',
  long: 'Fill in the fields of a PDF form. No fields yet? Draw them, or let PDF Tools find the blanks for you.',
  async setup(ctx) {
    const doc = ctx.items[0];
    // Fields as pdf.js reads them, with boxes in view points (top-left of the
    // page as shown, after /Rotate).
    const pages = [];
    for (let i = 0; i < doc.pages; i++) {
      const pg = await doc.js.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1 });
      const annots = (await pg.getAnnotations()).filter((a) => a.subtype === 'Widget' && a.fieldName);
      pages.push({ pg, vp, w: vp.width, h: vp.height, annots });
    }
    const existing = new Map();
    pages.forEach((p, i) => p.annots.forEach((a) => {
      const [x1, y1, x2, y2] = p.vp.convertToViewportRectangle(a.rect);
      const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      const kind = a.fieldType === 'Tx' ? (a.multiLine ? 'multi' : 'text') : a.fieldType === 'Btn' ? (a.checkBox ? 'check' : a.radioButton ? 'radio' : 'button') : a.fieldType === 'Ch' ? (a.combo ? 'select' : 'list') : 'sig';
      let f = existing.get(a.fieldName);
      if (!f) {
        const fv = a.fieldValue;
        const value = kind === 'check' ? !!fv && fv !== 'Off'
          : kind === 'radio' ? (fv && fv !== 'Off' ? fv : '')
            : kind === 'select' ? (Array.isArray(fv) ? fv[0] : fv) || ''
              : kind === 'list' ? (Array.isArray(fv) ? fv : fv ? [fv] : []) : fv || '';
        f = { name: a.fieldName, kind, widgets: [], value, options: a.options || [], multi: !!a.multiSelect, maxLen: a.maxLen || null, readOnly: !!a.readOnly };
        existing.set(a.fieldName, f);
      }
      f.widgets.push({ page: i, box, on: a.buttonValue || a.exportValue });
    }));
    const st = ctx.state = { doc, pages, existing: [...existing.values()], changed: new Map(), fields: [], sel: null, tool: null, flatten: false, mode: existing.size ? 'fill' : 'add' };

    const pageEls = pages.map((p, i) => {
      const canvas = h('canvas');
      renderPage(doc.js, i, 860, { canvas }).catch(() => {});
      const layer = h('div', { class: 'sm-layer' });
      layer.addEventListener('pointerdown', (e) => onDown(e, i));
      return { el: h('div', { class: 'sm-page', 'data-i': i, style: { aspectRatio: `${p.w} / ${p.h}` } }, canvas, layer), layer };
    });
    const pct = (v, of) => (v / of) * 100 + '%';
    const place = (el, i, b) => Object.assign(el.style, { left: pct(b.x, pages[i].w), top: pct(b.y, pages[i].h), width: pct(b.w, pages[i].w), height: pct(b.h, pages[i].h) });
    // Text in fields scales with the page (container query units).
    const fontFor = (i, b, cap = 13) => (Math.max(6, Math.min(cap, b.h * 0.62)) / pages[i].w) * 100 + 'cqw';

    /* filling in */
    const val = (f) => (st.changed.has(f.name) ? st.changed.get(f.name) : f.value);
    const twins = (f) => document.querySelectorAll(`[data-field="${CSS.escape(f.name)}"]`);
    const set = (f, v, from) => {
      st.changed.set(f.name, v);
      // A field can show up more than once (on every page, say): keep them in step.
      if (f.kind === 'text' || f.kind === 'multi') twins(f).forEach((x) => x !== from && (x.value = v));
      if (f.kind === 'check') twins(f).forEach((x) => (x.checked = v));
    };
    const inputFor = (f, w, k) => {
      const common = { class: 'sm-in sm-in--' + f.kind, 'data-field': f.name, disabled: f.readOnly, title: f.name, 'aria-label': f.name, style: { fontSize: fontFor(w.page, w.box) } };
      if (f.kind === 'text' || f.kind === 'multi') {
        const el = h(f.kind === 'multi' ? 'textarea' : 'input', { ...common, maxlength: f.maxLen, oninput: (e) => set(f, e.target.value, e.target) });
        el.value = val(f);
        return el;
      }
      if (f.kind === 'check') return h('input', { ...common, type: 'checkbox', checked: !!val(f), onchange: (e) => set(f, e.target.checked) });
      if (f.kind === 'radio') return h('input', { ...common, type: 'radio', name: 'sm-r-' + k, value: w.on, checked: val(f) === w.on, onchange: () => set(f, w.on) });
      if (f.kind === 'select' || f.kind === 'list') {
        const cur = val(f);
        return h('select', {
          ...common, multiple: f.kind === 'list' && f.multi, size: f.kind === 'list' ? Math.max(2, Math.floor(w.box.h / 12)) : null,
          onchange: (e) => set(f, f.kind === 'list' ? [...e.target.selectedOptions].map((o) => o.value) : e.target.value),
        },
        f.kind === 'select' && h('option', { value: '' }, ''),
        f.options.map((o) => h('option', { value: o.exportValue, selected: Array.isArray(cur) ? cur.includes(o.exportValue) : cur === o.exportValue }, o.displayValue ?? o.exportValue)));
      }
      return null; // push buttons and signature fields: nothing to type
    };

    /* adding fields */
    const els = new Map();
    const drawField = (f) => {
      const el = h('div', { class: `sm-fld sm-fld--${f.type}` + (f.id === st.sel ? ' on' : ''), 'data-id': f.id, style: { fontSize: fontFor(f.page, f, 11) } },
        h('span', { class: 'sm-fld__name' }, (f.type === 'radio' ? `${f.group}: ${f.value}` : f.name) + (f.required ? ' *' : '')),
        h('button', { type: 'button', class: 'sm-fld__x', 'aria-label': `Delete ${f.name}`, onclick: () => removeField(f) }, icon('x')),
        h('span', { class: 'sm-fld__size', 'aria-hidden': 'true' }));
      place(el, f.page, f);
      const old = els.get(f.id);
      if (old) old.replaceWith(el); else pageEls[f.page].layer.append(el);
      els.set(f.id, el);
    };
    const freeName = (want) => {
      const used = new Set([...st.existing.map((f) => f.name), ...st.fields.map((f) => (f.type === 'radio' ? f.group : f.name))]);
      const base = cleanName(want) || 'Field';
      if (!used.has(base)) return base;
      for (let k = 2; ; k++) if (!used.has(`${base} ${k}`)) return `${base} ${k}`;
    };
    const addField = (type, page, box, extra = {}) => {
      const f = { id: uid(), type, page, ...box, required: false, multiline: false, options: 'Option 1\nOption 2', ...extra };
      if (type === 'radio') { f.group ||= freeName('Choice'); f.value ||= 'Option 1'; f.name = f.group; } else f.name = freeName(extra.name || kindInfo(type)[1]);
      clampBox(f);
      st.fields.push(f);
      drawField(f);
      return f;
    };
    const removeField = (f) => {
      st.fields = st.fields.filter((x) => x !== f);
      els.get(f.id)?.remove();
      els.delete(f.id);
      if (st.sel === f.id) select(null); else count();
    };
    const select = (id) => {
      st.sel = id;
      els.forEach((el, k) => el.classList.toggle('on', k === id));
      drawProps();
    };
    const pt = (e, i) => {
      const r = pageEls[i].el.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * pages[i].w, y: ((e.clientY - r.top) / r.height) * pages[i].h };
    };
    const clampBox = (f) => {
      const P = pages[f.page];
      f.w = Math.min(Math.max(f.w, 8), P.w); f.h = Math.min(Math.max(f.h, 8), P.h);
      f.x = Math.min(Math.max(f.x, 0), P.w - f.w); f.y = Math.min(Math.max(f.y, 0), P.h - f.h);
    };
    function onDown(e, i) {
      if (st.mode !== 'add' || e.button > 0 || e.target.closest('.sm-fld__x')) return;
      const start = pt(e, i);
      const box = e.target.closest('.sm-fld');
      if (box) { // move, or resize by the corner
        const f = st.fields.find((x) => x.id === box.dataset.id);
        const from = { ...f };
        const resize = !!e.target.closest('.sm-fld__size');
        select(f.id);
        e.preventDefault();
        drag((ev) => {
          const q = pt(ev, i);
          if (resize) { f.w = from.w + q.x - start.x; f.h = square(f.type) ? f.w : from.h + q.y - start.y; } else { f.x = from.x + q.x - start.x; f.y = from.y + q.y - start.y; }
          clampBox(f);
          place(els.get(f.id), i, f);
        }, () => drawField(f));
        return;
      }
      if (!st.tool) { select(null); return; }
      e.preventDefault();
      const size = kindInfo(st.tool)[3];
      const f = addField(st.tool, i, { x: start.x, y: start.y - size.h / 2, w: size.w, h: size.h });
      setTool(null);
      select(f.id);
      if (e.pointerType !== 'mouse') return;
      drag((ev) => { // with a mouse, dragging out a box sets its size
        const q = pt(ev, i);
        if (Math.hypot(q.x - start.x, q.y - start.y) < 6) return;
        f.x = Math.min(start.x, q.x); f.y = Math.min(start.y, q.y);
        f.w = Math.abs(q.x - start.x); f.h = square(f.type) ? f.w : Math.max(Math.abs(q.y - start.y), 12);
        clampBox(f);
        place(els.get(f.id), i, f);
      }, () => drawField(f));
    }

    /* views */
    const pagesBox = h('div', { class: 'sm-pages' }, pageEls.map((p) => p.el));
    const toolBtns = new Map();
    const setTool = (t) => {
      st.tool = t && st.tool !== t ? t : null;
      toolBtns.forEach((b, k) => { b.classList.toggle('on', k === st.tool); b.setAttribute('aria-pressed', String(k === st.tool)); });
      pagesBox.classList.toggle('placing', !!st.tool);
      count();
    };
    const bar = h('div', { class: 'sm-bar', role: 'toolbar', 'aria-label': 'Add fields' },
      NEW_KINDS.map(([k, label, ic]) => {
        const b = h('button', { type: 'button', class: 'sm-tool', 'data-kind': k, 'aria-pressed': 'false', title: `Add a ${label.toLowerCase()} field`, onclick: () => setTool(k) }, icon(ic), h('span', {}, label));
        toolBtns.set(k, b);
        return b;
      }),
      h('button', { type: 'button', class: 'sm-tool sm-tool--detect', onclick: () => detect().catch((err) => { busy(false); toast(err.message, 'bad'); }) }, icon('smWand'), h('span', {}, 'Detect fields')));
    const hint = h('p', { class: 'sm-hint' });
    const count = () => {
      hint.textContent = st.mode === 'fill'
        ? `${st.existing.length} field${st.existing.length === 1 ? '' : 's'}. Click a field on the page to fill it in.`
        : st.tool ? `Now click the page where the ${kindInfo(st.tool)[1].toLowerCase()} goes.`
          : st.fields.length ? `${st.fields.length} new field${st.fields.length === 1 ? '' : 's'}. Drag one to move it; drag its corner to resize.`
            : 'Pick a field type above the page, then click where it goes. Or press Detect fields.';
    };
    const props = h('div', { class: 'sm-props' });
    const drawProps = () => {
      count();
      const f = st.fields.find((x) => x.id === st.sel);
      if (st.mode !== 'add' || !f) { props.replaceChildren(); return; }
      const redraw = () => { drawField(f); count(); };
      const group = () => st.fields.filter((x) => x.type === 'radio' && x.group === f.group);
      const rows = [h('p', { class: 'f__label sm-props__kind' }, icon(kindInfo(f.type)[2]), kindInfo(f.type)[1] + ' field')];
      if (f.type === 'radio') {
        rows.push(
          field('Group name', h('input', { class: 'field', value: f.group, oninput: (e) => { const g = group(); g.forEach((x) => { x.group = x.name = e.target.value.replace(/\./g, ' '); if (x !== f) drawField(x); }); redraw(); } })),
          field('This option’s value', h('input', { class: 'field', value: f.value, oninput: (e) => { f.value = e.target.value; redraw(); } })),
          h('button', { type: 'button', class: 'btn btn--ghost btn--block', onclick: () => {
            const g = addField('radio', f.page, { x: f.x, y: f.y + f.h + 8, w: f.w, h: f.h }, { group: f.group, value: `Option ${group().length + 1}`, required: f.required });
            select(g.id);
          } }, icon('plus'), 'Add another option'));
      } else rows.push(field('Name', h('input', { class: 'field', value: f.name, oninput: (e) => { f.name = e.target.value.replace(/\./g, ' '); redraw(); } })));
      if (f.type === 'select') rows.push(field('Options, one per line', h('textarea', { class: 'field sm-opts', rows: 4, oninput: (e) => (f.options = e.target.value) }, f.options)));
      if (f.type === 'text') rows.push(check('Several lines', f.multiline, (v) => (f.multiline = v)));
      rows.push(
        check('Required', f.required, (v) => { (f.type === 'radio' ? group() : [f]).forEach((x) => { x.required = v; drawField(x); }); }),
        h('button', { type: 'button', class: 'btn btn--ghost btn--block danger', onclick: () => removeField(f) }, icon('trash'), 'Delete field'));
      props.replaceChildren(...rows);
    };
    const drawLayers = () => {
      pageEls.forEach((p) => p.layer.replaceChildren());
      els.clear();
      st.existing.forEach((f, k) => f.widgets.forEach((w) => {
        const el = st.mode === 'fill' ? inputFor(f, w, k) : h('div', { class: 'sm-old', title: f.name });
        if (!el) return;
        place(el, w.page, w.box);
        pageEls[w.page].layer.append(el);
      }));
      if (st.mode === 'add') st.fields.forEach(drawField);
      pagesBox.classList.toggle('adding', st.mode === 'add');
      bar.hidden = st.mode !== 'add';
      setTool(null);
      drawProps();
    };

    async function detect() {
      busy('Looking for blanks…');
      const taken = [...st.existing.flatMap((f) => f.widgets), ...st.fields.map((f) => ({ page: f.page, box: f }))];
      const found = await detectFields(pages, taken);
      busy(false);
      if (!found.length) { toast('No blanks found. Add fields by hand instead.'); return; }
      found.forEach((d) => addField(d.type, d.page, d.box, { name: d.name, detected: true }));
      select(null);
      toast(`Found ${found.length} field${found.length > 1 ? 's' : ''}. Check them, then save.`);
    }

    ctx.main.append(h('div', { class: 'sm-forms' }, bar, pagesBox));
    ctx.side.append(
      st.existing.length
        ? segmented([['fill', 'Fill in'], ['add', 'Add fields']], st.mode, (v) => { st.mode = v; drawLayers(); })
        : h('p', { class: 'sm-note' }, icon('smInfo'), 'This PDF has no form fields yet. Add some, or press Detect fields.'),
      hint, props,
      check('Flatten: answers become part of the page and can’t be changed', st.flatten, (v) => (st.flatten = v)));
    drawLayers();
  },
  async run(ctx) {
    const st = ctx.state;
    if (!st.changed.size && !st.fields.length && !st.flatten) throw new Error(st.existing.length ? 'Fill in a field, or add one, first.' : 'Add a field first.');
    const lib = await loadLib(st.doc);
    const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFName, PDFBool } = window.PDFLib;
    const form = lib.getForm();
    const problems = [];
    for (const [name, v] of st.changed) {
      const f = form.getFieldMaybe(name);
      try {
        if (f instanceof PDFTextField) f.setText(v || undefined);
        else if (f instanceof PDFCheckBox) v ? f.check() : f.uncheck();
        else if (f instanceof PDFRadioGroup) {
          // pdf.js gives the button's own "on" name; with /Opt (as pdf-lib
          // writes) that is an index, and the option's name is in /Opt.
          const opts = f.getOptions();
          const k = f.acroField.getOnValues().findIndex((o) => o.decodeText() === v);
          if (!v) f.clear(); else f.select(opts.includes(v) || k < 0 ? v : opts[k]);
        } else if (f instanceof PDFDropdown) v ? f.select(v) : f.clear();
        else if (f instanceof PDFOptionList) v.length ? f.select(v) : f.clear();
      } catch (err) { console.warn(name, err); problems.push(name); }
    }
    const helv = await lib.embedFont(StandardFonts.Helvetica);
    const radios = new Map();
    for (const f of st.fields) {
      const page = lib.getPage(f.page);
      const fr = pageFrame(page);
      // pdf.js and pdf-lib can disagree slightly on page size; scale to match.
      const kx = fr.W / st.pages[f.page].w, ky = fr.H / st.pages[f.page].h;
      const W = f.w * kx, H = f.h * ky;
      // Turned with the page, so the field reads upright on a rotated page.
      const a = boxAnchor(fr, (f.x + f.w / 2) * kx, (f.y + f.h / 2) * ky, W, H);
      const opts = { x: a.x, y: a.y, width: W, height: H, rotate: a.rotate, borderWidth: 1, borderColor: rgb(0.55, 0.57, 0.68), backgroundColor: rgb(0.96, 0.97, 1), textColor: rgb(0.07, 0.07, 0.2), font: helv };
      if (f.type === 'radio') {
        let g = radios.get(f.group);
        if (!g) { g = form.createRadioGroup(uniqueName(form, f.group)); radios.set(f.group, g); }
        g.addOptionToPage(f.value || 'Option', page, opts);
        if (f.required) g.enableRequired();
        continue;
      }
      const name = uniqueName(form, f.name);
      if (f.type === 'check') {
        const c = form.createCheckBox(name);
        c.addToPage(page, opts);
        if (f.required) c.enableRequired();
      } else if (f.type === 'select') {
        const list = String(f.options).split(/\s*[,\n]\s*/).filter(Boolean);
        if (!list.length) throw new Error(`Give the dropdown “${f.name}” at least one option.`);
        const d = form.createDropdown(name);
        d.addOptions(list);
        d.addToPage(page, opts);
        if (f.required) d.enableRequired();
      } else {
        const t = form.createTextField(name);
        if (f.multiline) t.enableMultiline();
        t.addToPage(page, f.type === 'sig' ? { ...opts, backgroundColor: rgb(1, 0.98, 0.92) } : opts);
        t.setFontSize(f.multiline ? 10 : Math.max(6, Math.min(14, H * 0.6)));
        if (f.required) t.enableRequired();
      }
    }
    busy('Saving…');
    let bytes;
    try {
      if (st.flatten) form.flatten();
      bytes = await lib.save();
    } catch (err) {
      // pdf-lib draws answers with a Latin-only font. Without flattening, PDF
      // readers can draw them instead (NeedAppearances).
      if (!/encode|WinAnsi/i.test(err?.message || '')) throw err;
      if (st.flatten) throw new Error('Some answers use letters the built-in PDF font can’t show (like Urdu or Arabic). Turn off Flatten and save again; PDF readers will show them.');
      form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
      bytes = await lib.save({ updateFieldAppearances: false });
    }
    const added = st.fields.length;
    return {
      files: [pdfOut(`${baseName(st.doc.name)}-${added ? 'form' : 'filled'}.pdf`, bytes)],
      title: added ? 'Your fillable PDF is ready' : st.flatten ? 'Your form is filled and flattened' : 'Your form is filled',
      note: [
        st.changed.size && `${st.changed.size} answer${st.changed.size > 1 ? 's' : ''} saved.`,
        added && `${added} field${added > 1 ? 's' : ''} added.`,
        problems.length && `Could not fill: ${problems.join(', ')}.`,
      ].filter(Boolean).join(' '),
    };
  },
};

const cleanName = (s) => String(s || '').replace(/[_:.*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

function uniqueName(form, want) {
  const base = cleanName(want) || 'Field';
  if (!form.getFieldMaybe(base)) return base;
  for (let k = 2; ; k++) if (!form.getFieldMaybe(`${base} ${k}`)) return `${base} ${k}`;
}

function drag(onMove, onUp) {
  const up = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); onUp(); };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// Proposes fields from what the page shows: runs of underscores ("Name: ____"),
// labels ending in ":" with nothing after them, box characters (☐ □), and
// empty squares or wide empty boxes drawn on the page.
async function detectFields(pages, taken) {
  const found = [];
  const hits = (i, b) => [...taken, ...found].some((t) => t.page === i && b.x < t.box.x + t.box.w - 2 && t.box.x < b.x + b.w - 2 && b.y < t.box.y + t.box.h - 2 && t.box.y < b.y + b.h - 2);
  const add = (type, i, box, name) => { if (box.w > 4 && box.h > 4 && !hits(i, box)) found.push({ type, page: i, box, name: cleanName(name) }); };
  const { Util, OPS } = window.pdfjsLib;
  const BOXES = /[☐□❏❑▢⬜]/gu;
  for (const [i, P] of pages.entries()) {
    const tc = await P.pg.getTextContent();
    const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
      const tx = Util.transform(P.vp.transform, it.transform);
      const size = Math.hypot(tx[2], tx[3]);
      const upright = size > 0 && Math.abs(tx[1]) < 0.01 * size && Math.abs(tx[2]) < 0.01 * size && tx[0] > 0 && tx[3] < 0;
      return { str: it.str, x: tx[4], base: tx[5], size, w: it.width * (size / (Math.hypot(it.transform[2], it.transform[3]) || 1)), family: tc.styles[it.fontName]?.fontFamily || 'sans-serif', upright };
    }).filter((t) => t.upright);
    // x of character k inside an item, measured with a similar font
    const xAt = (t, k) => {
      measurer.font = `${t.size}px ${t.family}`;
      const all = measurer.measureText(t.str).width || 1;
      return t.x + (t.w * measurer.measureText(t.str.slice(0, k)).width) / all;
    };
    const sameLine = (a, b) => Math.abs(a.base - b.base) < a.size * 0.5;
    const before = (t, x) => items.filter((o) => o !== t && sameLine(o, t) && o.x + o.w <= x + 1).sort((a, b) => b.x - a.x)[0];
    const after = (t, x) => items.filter((o) => o !== t && sameLine(o, t) && o.x >= x - 1).sort((a, b) => a.x - b.x)[0];
    for (const t of items) {
      for (const m of t.str.matchAll(/_{3,}/g)) {
        const x0 = xAt(t, m.index), x1 = xAt(t, m.index + m[0].length);
        const label = t.str.slice(0, m.index).split(/_{3,}/).pop().trim() || before(t, t.x)?.str.split(/_{3,}/).pop() || '';
        add('text', i, { x: x0, y: t.base - t.size * 1.05, w: x1 - x0, h: t.size * 1.25 }, label);
      }
      for (const m of t.str.matchAll(BOXES)) {
        const x0 = xAt(t, m.index), x1 = xAt(t, m.index + m[0].length);
        const side = Math.min(t.size * 0.9, Math.max(x1 - x0, t.size * 0.6));
        const label = t.str.slice(m.index + m[0].length).split(BOXES)[0].trim() || after(t, x1)?.str || 'Checkbox';
        add('check', i, { x: x0 + (x1 - x0 - side) / 2, y: t.base - t.size * 0.8, w: side, h: side }, label);
      }
      if (/:\s*$/.test(t.str)) {
        const end = t.x + t.w;
        const next = after(t, end);
        const room = (next ? next.x : P.w - 36) - end;
        if (room >= 60) add('text', i, { x: end + 6, y: t.base - t.size * 1.05, w: Math.min(room - 12, 260), h: t.size * 1.25 }, t.str);
      }
    }
    // Rectangles drawn on the page with no text inside.
    const ops = await P.pg.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k], args = ops.argsArray[k];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
      else if (fn === OPS.constructPath) {
        const r = pathRect(args[0], args[1], OPS);
        if (!r) continue;
        const m = Util.transform(P.vp.transform, ctm);
        const [ax, ay] = Util.applyTransform([r.x0, r.y0], m), [bx, by] = Util.applyTransform([r.x1, r.y1], m);
        const box = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
        if (items.some((t) => t.x < box.x + box.w && t.x + t.w > box.x && t.base > box.y && t.base - t.size * 0.7 < box.y + box.h)) continue;
        const line = { base: box.y + box.h - 2, size: Math.max(box.h, 10) };
        if (box.w >= 7 && box.w <= 22 && Math.abs(box.w - box.h) < 2) add('check', i, box, after(line, box.x + box.w)?.str || 'Checkbox');
        else if (box.w >= 50 && box.w <= P.w * 0.8 && box.h >= 12 && box.h <= 60) add('text', i, box, before(line, box.x)?.str || '');
      }
    }
  }
  return found;
}

// The bounding box of a path that is one axis-aligned rectangle, or null.
function pathRect(sub, coords, OPS) {
  if (sub.length === 1 && sub[0] === OPS.rectangle) {
    const [x, y, w, hh] = coords;
    return { x0: x, y0: y, x1: x + w, y1: y + hh };
  }
  if (sub.length < 4 || sub.length > 6 || sub[0] !== OPS.moveTo || sub.some((o) => o !== OPS.moveTo && o !== OPS.lineTo && o !== OPS.closePath)) return null;
  const pts = [];
  for (let c = 0; c + 1 < coords.length; c += 2) pts.push([coords[c], coords[c + 1]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const corner = (p) => (Math.abs(p[0] - r.x0) < 0.5 || Math.abs(p[0] - r.x1) < 0.5) && (Math.abs(p[1] - r.y0) < 0.5 || Math.abs(p[1] - r.y1) < 0.5);
  return pts.length >= 4 && pts.every(corner) ? r : null;
}

/* ---------- WORKFLOWS ---------- */

const KEY = 'pdftools.workflows';
const loadFlows = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const saveFlows = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; } };

const PRESETS = [
  { name: 'Ready to share', steps: [{ type: 'compress', level: 'medium' }, { type: 'numbers', format: 'n', pos: 'bc' }] },
  { name: 'Confidential', steps: [{ type: 'watermark', text: 'CONFIDENTIAL', opacity: 0.3 }, { type: 'protect', password: '' }] },
];

const NUM_FORMATS = [['n', '1'], ['page', 'Page 1'], ['of', 'Page 1 of 9'], ['slash', '1 / 9']];
const NUM_POS = [['bl', 'Bottom left'], ['bc', 'Bottom center'], ['br', 'Bottom right'], ['tl', 'Top left'], ['tc', 'Top center'], ['tr', 'Top right']];
const eachLib = async (docs, fn) => { for (const d of docs) await fn(d.lib); return docs; };

// Each step: what it shows in its card (ui) and what it does (apply).
const STEPS = {
  merge: {
    label: 'Merge files', icon: 'merge', note: 'Joins the files into one, in the order shown above.',
    async apply(docs) {
      if (docs.length < 2) return docs;
      const out = await PDFDocument.create();
      for (const d of docs) (await out.copyPages(d.lib, d.lib.getPageIndices())).forEach((p) => out.addPage(p));
      return [{ name: 'merged', lib: out }];
    },
  },
  rotate: {
    label: 'Rotate pages', icon: 'rotate', def: { angle: 90 },
    ui: (st, up) => segmented([[90, '90° right'], [180, '180°'], [270, '90° left']], st.angle, (v) => up({ angle: v })),
    apply: (docs, st) => eachLib(docs, (lib) => lib.getPages().forEach((p) => p.setRotation(degrees((p.getRotation().angle + st.angle) % 360)))),
  },
  numbers: {
    label: 'Add page numbers', icon: 'numbers', def: { format: 'n', pos: 'bc' },
    ui: (st, up) => h('div', { class: 'row2' },
      field('Style', h('select', { class: 'field', onchange: (e) => up({ format: e.target.value }) }, NUM_FORMATS.map(([v, l]) => h('option', { value: v, selected: v === st.format }, l)))),
      field('Where', h('select', { class: 'field', onchange: (e) => up({ pos: e.target.value }) }, NUM_POS.map(([v, l]) => h('option', { value: v, selected: v === st.pos }, l))))),
    apply: (docs, st) => eachLib(docs, (lib) => stampNumbers(lib, lib.getPageIndices(), { pos: st.pos, margin: 28, start: 1, format: st.format, size: 11, color: '#111111', pages: '', total: lib.getPageCount() })),
  },
  watermark: {
    label: 'Add watermark', icon: 'watermark', def: { text: 'CONFIDENTIAL', opacity: 0.3 },
    ui: (st, up) => h('div', { class: 'row2 sm-row' },
      field('Text', h('input', { class: 'field', value: st.text, oninput: (e) => up({ text: e.target.value }) })),
      field('See-through', slider(0.05, 1, 0.05, st.opacity, (v) => `${Math.round(v * 100)}%`, (v) => up({ opacity: v })))),
    apply(docs, st) {
      if (!st.text.trim()) throw new Error('Type the text for the watermark step.');
      return eachLib(docs, (lib) => stampWatermark(lib, lib.getPageIndices(), { kind: 'text', text: st.text, size: 60, color: '#e11d48', opacity: st.opacity, angle: 45, pos: 'mc', tile: false }));
    },
  },
  compress: {
    label: 'Compress', icon: 'compress', def: { level: 'medium' },
    ui: (st, up) => segmented([['low', 'Light'], ['medium', 'Recommended'], ['high', 'Extreme']], st.level, (v) => up({ level: v })),
    apply: (docs, st) => eachLib(docs, (lib) => shrinkImages(lib, LEVELS[st.level], (k, n) => busy(`Compressing image ${k} of ${n}…`))),
  },
  protect: {
    label: 'Protect with password', icon: 'protect', def: { password: '' }, note: 'Always runs last. Passwords are never saved with a workflow.',
    ui: (st, up) => field('Password', h('input', { class: 'field', type: 'password', autocomplete: 'new-password', value: st.password || '', placeholder: 'Type a password', oninput: (e) => up({ password: e.target.value }) })),
    apply: (docs, st) => eachLib(docs, (lib) => lib.encrypt({
      userPassword: st.password, ownerPassword: st.password,
      permissions: { printing: 'highResolution', copying: true, modifying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true },
    })),
  },
  dropFirst: {
    label: 'Remove first page', icon: 'trash', note: 'A file with one page keeps it.',
    apply: (docs) => eachLib(docs, (lib) => lib.getPageCount() > 1 && lib.removePage(0)),
  },
  dropBlank: {
    label: 'Remove blank pages', icon: 'pages', note: 'Takes out pages with nothing on them. A file never ends up empty.',
    apply: (docs) => eachLib(docs, removeBlankPages),
  },
};

// A page is blank when, drawn small, almost no pixel is darker than paper.
async function removeBlankPages(lib) {
  const js = await window.pdfjsLib.getDocument({ data: await lib.save(), isEvalSupported: false }).promise;
  const blank = [];
  for (let i = 0; i < js.numPages; i++) {
    const c = await renderPage(js, i, 0, { lazy: false, scale: 0.3 });
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] < 225 || d[k + 1] < 225 || d[k + 2] < 225) ink++;
    if (ink / (d.length / 4) < 0.0008) blank.push(i);
    c.width = c.height = 0;
  }
  if (blank.length === js.numPages) blank.shift();
  js.destroy();
  blank.reverse().forEach((i) => lib.removePage(i));
}

const workflow = {
  id: 'workflow', title: 'Workflows', icon: 'workflow', color: '#6646e8', cat: 'workflows', multiple: true, action: 'Run workflow', busyText: 'Running…',
  keywords: 'automate batch chain steps preset routine',
  desc: 'Chain several tools and run them on your PDFs in one go.',
  long: 'Build a chain of steps, like compress then add page numbers, and run it on one or more PDFs. Save the ones you use often.',
  setup(ctx) {
    const s = ctx.state = { steps: [], name: '' };
    const load = (flow) => { s.steps = flow.steps.map((x) => ({ ...STEPS[x.type].def, ...x, id: uid() })); s.name = flow.name; drawSteps(); drawSaved(); };

    const files = h('div', { class: 'sm-files' });
    const drawFiles = () => {
      files.replaceChildren(...ctx.items.map((d) => h('div', { class: 'sm-file' }, fileRow(d),
        ctx.items.length > 1 && h('button', { class: 'iconbtn', 'aria-label': `Remove ${d.name}`, onclick: () => { ctx.items.splice(ctx.items.indexOf(d), 1); drawFiles(); } }, icon('x')))),
      h('button', { class: 'btn btn--ghost sm-files__add', onclick: async () => { ctx.items.push(...(await ctx.addMore())); drawFiles(); } }, icon('plus'), 'Add PDFs'));
      drawSteps();
    };
    ctx.onDropMore = (more) => { ctx.items.push(...more); drawFiles(); };

    const list = h('ol', { class: 'sm-steps' });
    const drawSteps = () => {
      list.replaceChildren(...s.steps.map((st, k) => {
        const def = STEPS[st.type];
        // Text boxes and sliders keep focus: only buttons and menus redraw.
        const up = (patch) => { Object.assign(st, patch); };
        const move = (d) => { [s.steps[k], s.steps[k + d]] = [s.steps[k + d], s.steps[k]]; drawSteps(); };
        const warn = st.type === 'merge' && ctx.items.length < 2 && 'Only one file, so there is nothing to merge. Add PDFs above.';
        return h('li', { class: 'sm-step', 'data-type': st.type },
          h('div', { class: 'sm-step__head' },
            h('span', { class: 'sm-step__num' }, String(k + 1)),
            h('span', { class: 'sm-step__icon' }, icon(def.icon)),
            h('strong', {}, def.label),
            h('span', { class: 'sm-step__btns' },
              h('button', { class: 'iconbtn', title: 'Move up', 'aria-label': `Move ${def.label} up`, disabled: k === 0, onclick: () => move(-1) }, icon('smUp')),
              h('button', { class: 'iconbtn', title: 'Move down', 'aria-label': `Move ${def.label} down`, disabled: k === s.steps.length - 1, onclick: () => move(1) }, icon('smDown')),
              h('button', { class: 'iconbtn', title: 'Remove', 'aria-label': `Remove ${def.label}`, onclick: () => { s.steps.splice(k, 1); drawSteps(); } }, icon('x')))),
          (def.ui || def.note || warn) && h('div', { class: 'sm-step__body' }, def.ui?.(st, up), def.note && h('p', { class: 'muted small' }, def.note), warn && h('p', { class: 'small bad' }, warn)));
      }), !s.steps.length && h('li', { class: 'sm-steps__empty' }, 'No steps yet. Add one below.'));
      ctx.action.disabled = !s.steps.length;
    };
    const adders = h('div', { class: 'sm-add' }, Object.entries(STEPS).map(([type, def]) =>
      h('button', { type: 'button', class: 'chip sm-add__btn', 'data-add': type, onclick: () => { s.steps.push({ ...def.def, type, id: uid() }); drawSteps(); } }, icon('plus'), def.label)));

    const picker = h('select', { class: 'field', 'aria-label': 'Start from' });
    const nameIn = h('input', { class: 'field', placeholder: 'Name this workflow', maxlength: 60, 'aria-label': 'Workflow name' });
    const del = h('button', { class: 'btn btn--ghost danger', type: 'button' }, icon('trash'), 'Delete');
    const drawSaved = () => {
      const mine = loadFlows();
      const isMine = mine.some((m) => m.name === s.name);
      picker.replaceChildren(
        h('optgroup', { label: 'Starters' }, PRESETS.map((f, k) => h('option', { value: 'p' + k, selected: !isMine && f.name === s.name }, f.name))),
        mine.length && h('optgroup', { label: 'Saved on this device' }, mine.map((f, k) => h('option', { value: 'm' + k, selected: f.name === s.name }, f.name))));
      nameIn.value = s.name;
      del.hidden = !isMine;
    };
    picker.addEventListener('change', () => load(picker.value[0] === 'p' ? PRESETS[+picker.value.slice(1)] : loadFlows()[+picker.value.slice(1)]));
    const save = () => {
      const name = nameIn.value.trim();
      if (!name) return toast('Give the workflow a name first.', 'bad');
      if (!s.steps.length) return toast('Add a step first.', 'bad');
      const steps = s.steps.map(({ id, password, ...rest }) => rest); // never store passwords
      if (!saveFlows([...loadFlows().filter((f) => f.name !== name), { name, steps }])) return toast('This browser would not let us save it.', 'bad');
      s.name = name;
      drawSaved();
      toast(`Saved “${name}” on this device.`);
    };
    del.addEventListener('click', () => {
      saveFlows(loadFlows().filter((f) => f.name !== s.name));
      toast(`Deleted “${s.name}”.`);
      load(PRESETS[0]);
    });

    ctx.main.append(
      h('section', { class: 'sm-wf' }, h('h3', { class: 'sm-h' }, 'Files'), files),
      h('section', { class: 'sm-wf' }, h('h3', { class: 'sm-h' }, 'Steps'), list, h('p', { class: 'f__label' }, 'Add a step'), adders));
    ctx.side.append(
      h('p', {}, 'Steps run from top to bottom, on every file. Use the arrows to change the order.'),
      field('Start from', picker),
      field('Save as', nameIn),
      h('div', { class: 'row2' }, h('button', { class: 'btn btn--soft', type: 'button', onclick: save }, icon('check'), 'Save'), del),
      h('p', { class: 'muted small' }, 'Saved workflows stay in this browser.'));
    load(PRESETS[0]);
    drawFiles();
  },
  async run(ctx) {
    const s = ctx.state;
    if (!s.steps.length) throw new Error('Add at least one step.');
    const lock = s.steps.find((x) => x.type === 'protect');
    if (lock && !lock.password) throw new Error('Type a password in the Protect step.');
    const steps = [...s.steps.filter((x) => x.type !== 'protect'), ...(lock ? [lock] : [])];
    let docs = [];
    for (const d of ctx.items) docs.push({ name: baseName(d.name), lib: await loadLib(d) });
    for (const [k, st] of steps.entries()) {
      busy(`Step ${k + 1} of ${steps.length}: ${STEPS[st.type].label}…`);
      await tick();
      docs = await STEPS[st.type].apply(docs, st);
    }
    const tag = s.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'workflow';
    const files = [];
    for (const [k, d] of docs.entries()) {
      busy(docs.length > 1 ? `Saving ${k + 1} of ${docs.length}…` : 'Saving…');
      files.push(pdfOut(`${d.name}-${tag}.pdf`, await d.lib.save()));
    }
    return {
      files, zipName: `${tag}.zip`,
      title: files.length > 1 ? `${files.length} PDFs are ready` : 'Your PDF is ready',
      note: steps.map((x) => STEPS[x.type].label).join(' → '),
    };
  },
};

export const SMART = [summarize, translate, forms, workflow];
