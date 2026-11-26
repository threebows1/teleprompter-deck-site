// PDF to Word, PowerPoint, Excel and Markdown rebuild a document from the
// text pdf.js finds: where each piece sits gives lines, paragraphs, headings,
// lists and tables. PDF to PDF/A makes an archival copy. All of it runs here,
// in the browser.
import { h, icon, busy, tick, toast, registerIcons, loadScript, loadLib, renderPage, baseName, degrees } from '../core.js';
import { field, segmented, choiceCards, check, fileHero, fileRow, pdfOut } from '../ui.js';
import { readPage, matchItems, dropOps, invisibleShows } from '../content.js';

registerIcons({
  toWord: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m8 12 1.5 5 2.5-4 2.5 4 1.5-5"/>',
  toPpt: '<path d="M2 4h20"/><path d="M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4"/><path d="m8 21 4-5 4 5"/><path d="M9 12V9"/><path d="M12 12V7"/><path d="M15 12v-2"/>',
  toExcel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 9v12"/><path d="M15 9v12"/>',
  toPdfa: '<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  toMd: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6"/><path d="M17 9v6"/><path d="m14.5 12.5 2.5 2.5 2.5-2.5"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
});

const { Util, OPS } = window.pdfjsLib;
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const BULLET = /^[•●○◦▪■□‣⁃∙·*–-]\s+/;
const NUMBERED = /^(\d{1,3})[.)]\s+/;
const MARKER = /^([•●○◦▪■□‣⁃∙·*–-]|\d{1,3}[.)])$/;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const safeUrl = (u) => (/^(https?:|mailto:|tel:)/i.test(u || '') ? u : null);

/* ---------- reading a page ---------- */

// Everything the converters need from one page, in view points (top-left
// origin, after /Rotate): text pieces with their style, links, picture areas.
// Odd ToUnicode maps can yield control characters and lone surrogates, which
// are not allowed in Word/PowerPoint/Excel XML.
const clean = (t) => t
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');

let ruler;
const textWidth = (s, size) => {
  ruler ||= document.createElement('canvas').getContext('2d');
  ruler.font = '100px Arial, Helvetica, sans-serif';
  return (ruler.measureText(s).width / 100) * size;
};

async function readPdfPage(doc, i, lib) {
  const page = await doc.js.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList(); // also loads the fonts, so their real names are known
  const tc = await page.getTextContent();
  const raw = tc.items.filter((it) => typeof it.str === 'string');
  // The content stream gives colors, and which text is invisible (the layer OCR puts over a scan).
  let read = null;
  let hidden = new Set();
  if (lib) {
    try {
      read = readPage(lib, i);
      matchItems(raw, read.shows);
      hidden = invisibleShows(read.ops);
    } catch (err) { console.warn('content stream not read', err); read = null; }
  }
  const annots = await page.getAnnotations();
  const links = annots.filter((a) => a.subtype === 'Link' && safeUrl(a.url))
    .map((a) => ({ url: a.url, r: normRect(vp.convertToViewportRectangle(a.rect)) }));
  const items = [];
  // What is typed into form fields and comment boxes is drawn by the
  // annotation, not the page, so pdf.js leaves it out of the page's text.
  for (const a of annots) {
    if (a.hidden || a.noView) continue;
    let str = '';
    if (a.subtype === 'Widget' && a.fieldType === 'Tx' && typeof a.fieldValue === 'string') str = a.fieldValue;
    else if (a.subtype === 'Widget' && a.fieldType === 'Ch') str = [].concat(a.fieldValue || []).join(', ');
    else if (a.subtype === 'Widget' && a.checkBox) str = a.fieldValue && a.fieldValue !== 'Off' ? '☒' : '☐';
    else if (a.subtype === 'FreeText') str = a.contentsObj?.str || '';
    if (!str.trim()) continue;
    const r = normRect(vp.convertToViewportRectangle(a.rect));
    const rows = str.split(/\r\n|\r|\n/);
    const size = clamp(a.defaultAppearanceData?.fontSize || Math.min(11, ((r[3] - r[1]) / rows.length) * 0.7), 4, 24);
    const multi = rows.length > 1 || a.multiLine;
    rows.forEach((row, k) => {
      if (!row.trim()) return;
      const y = multi ? r[1] + size * (1.15 * k + 1) + 1 : r[3] - ((r[3] - r[1]) - size) / 2 - size * 0.2;
      items.push({
        str: clean(row), x: r[0] + 2, y, w: textWidth(row, size), size,
        font: 'Arial', bold: false, italic: false, color: '#000000', hidden: false, ops: [], link: null,
      });
    });
  }
  for (const it of raw) {
    if (!it.str.trim()) continue;
    const t = Util.transform(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]);
    // Turned or mirrored text has no place in flowing text.
    if (size < 1 || t[0] <= 0 || Math.abs(t[1]) > size * 0.05) continue;
    const name = fontName(page, it.fontName);
    const ops = it.own?.length ? it.own : it.parent >= 0 ? [it.parent] : [];
    const item = {
      str: clean(it.str), x: t[4], y: t[5], w: it.width, size,
      font: family(name, tc.styles[it.fontName]?.fontFamily),
      bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name),
      color: it.color || '#000000', hidden: ops.some((k) => hidden.has(k)), ops, link: null,
    };
    const cx = item.x + item.w / 2, cy = item.y - size * 0.3;
    item.link = links.find(({ r }) => cx >= r[0] - 1 && cx <= r[2] + 1 && cy >= r[1] - 1 && cy <= r[3] + 1)?.url || null;
    items.push(item);
  }
  return { w: vp.width, h: vp.height, items, ...drawings(opList, vp), read };
}

const normRect = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

function fontName(page, id) {
  try { return (page.commonObjs.get(id)?.name || '').replace(/^[A-Z]{6}\+/, ''); } catch { return ''; }
}

// "TimesNewRomanPSMT" -> "Times New Roman", "Arial-BoldMT" -> "Arial".
function family(name, generic) {
  const f = name.split(/[-,+]/)[0].replace(/(PS)?MT$|PS$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (f && !/^(CIDFont|Font|[A-Z]\d+$|g_)/i.test(f)) return f;
  return { serif: 'Times New Roman', monospace: 'Courier New' }[generic] || 'Arial';
}

// A path's pieces, each a list of points (curves by their control points).
// A `re` is a piece of its own, marked as a rectangle.
function subpaths(ops, coords) {
  const out = [];
  let cur = null, at = 0;
  for (const op of ops) {
    const n = { [OPS.moveTo]: 2, [OPS.lineTo]: 2, [OPS.curveTo]: 6, [OPS.curveTo2]: 4, [OPS.curveTo3]: 4, [OPS.rectangle]: 4 }[op] || 0;
    const c = coords.slice(at, at + n);
    at += n;
    if (op === OPS.rectangle) {
      out.push({ pts: [[c[0], c[1]], [c[0] + c[2], c[1]], [c[0] + c[2], c[1] + c[3]], [c[0], c[1] + c[3]]], rect: true });
      cur = null;
    } else if (op === OPS.moveTo) {
      cur = { pts: [[c[0], c[1]]] };
      out.push(cur);
    } else if (n && cur) {
      for (let j = 0; j < n; j += 2) cur.pts.push([c[j], c[j + 1]]);
      if (op !== OPS.lineTo) cur.curved = true;
    }
  }
  return out.filter((sp) => sp.pts.length > 1);
}

const FILLS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const hex = (c) => '#' + [...c].slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const whiteish = (c) => c[0] > 245 && c[1] > 245 && c[2] > 245;

// From the operator list, in view space: where pictures are painted
// (overlapping ones merge), small filled dots (list bullets drawn as shapes),
// thin lines (table borders), filled boxes (shading behind text and cells)
// and other shapes (vector logos, charts).
function drawings({ fnArray, argsArray }, vp) {
  const stack = [];
  let gs = { ctm: [1, 0, 0, 1, 0, 0], fill: [0, 0, 0], stroke: [0, 0, 0], lw: 1 };
  const boxes = [], srcs = [], dots = [], rules = [], fills = [], shapes = [];
  const viewBox = (corners) => {
    const m = Util.transform(vp.transform, gs.ctm);
    const pts = corners.map((p) => Util.applyTransform(p, m));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const rule = (x0, y0, x1, y1, width, color) => {
    if (Math.abs(y1 - y0) <= Math.abs(x1 - x0)) {
      if (Math.abs(x1 - x0) >= 3) rules.push({ dir: 'h', pos: (y0 + y1) / 2, from: Math.min(x0, x1), to: Math.max(x0, x1), width, color });
    } else if (Math.abs(y1 - y0) >= 3) rules.push({ dir: 'v', pos: (x0 + x1) / 2, from: Math.min(y0, y1), to: Math.max(y0, y1), width, color });
  };
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k], a = argsArray[k];
    if (fn === OPS.save) { stack.push(gs); gs = { ...gs }; }
    else if (fn === OPS.restore) gs = stack.pop() || gs;
    else if (fn === OPS.transform) gs.ctm = Util.transform(gs.ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(gs); gs = { ...gs }; if (a[0]?.length === 6) gs.ctm = Util.transform(gs.ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) gs = stack.pop() || gs;
    else if (fn === OPS.setFillRGBColor) gs.fill = [a[0], a[1], a[2]];
    else if (fn === OPS.setStrokeRGBColor) gs.stroke = [a[0], a[1], a[2]];
    else if (fn === OPS.setLineWidth) gs.lw = a[0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageMaskXObject) {
      const v = viewBox([[0, 0], [1, 0], [0, 1], [1, 1]]);
      const b = [clamp(v[0], 0, vp.width), clamp(v[1], 0, vp.height), clamp(v[2], 0, vp.width), clamp(v[3], 0, vp.height)];
      if (b[2] - b[0] >= 16 && b[3] - b[1] >= 16) {
        boxes.push(b);
        if (fn !== OPS.paintImageMaskXObject) srcs.push({ box: b, src: a[0], m: Util.transform(vp.transform, gs.ctm) });
      }
      else if (b[2] - b[0] >= 3 && b[3] - b[1] >= 3) shapes.push({ box: b, color: '#000000' }); // a small piece of a logo
    } else if (fn === OPS.constructPath) {
      const paint = fnArray[k + 1];
      const doFill = FILLS.has(paint), doStroke = STROKES.has(paint);
      if (!doFill && !doStroke) continue; // a clipping path
      const m = Util.transform(vp.transform, gs.ctm);
      const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      const lw = Math.max(0.5, gs.lw * scale);
      for (const sp of subpaths(a[0], a[1])) {
        const pts = sp.pts.map((p) => Util.applyTransform(p, m));
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        const w = b[2] - b[0], hh = b[3] - b[1];
        const closedPts = pts.length === 5 && Math.hypot(pts[4][0] - pts[0][0], pts[4][1] - pts[0][1]) < 0.5 ? pts.slice(0, 4) : pts;
        const isRect = sp.rect || (!sp.curved && closedPts.length === 4 && closedPts.every((p, j) => {
          const q = closedPts[(j + 1) % 4];
          return Math.abs(p[0] - q[0]) < 0.5 || Math.abs(p[1] - q[1]) < 0.5;
        }));
        if (doFill) {
          if (w >= 1.5 && w <= 8 && hh >= 1.5 && hh <= 8 && Math.max(w, hh) / Math.min(w, hh) < 1.5) dots.push(b);
          if (isRect && Math.min(w, hh) <= 2.5) { // a line drawn as a thin box
            const t = Math.max(0.5, Math.min(w, hh)), my = (b[1] + b[3]) / 2, mx = (b[0] + b[2]) / 2;
            if (w >= hh) rule(b[0], my, b[2], my, t, hex(gs.fill));
            else rule(mx, b[1], mx, b[3], t, hex(gs.fill));
          } else if (!whiteish(gs.fill)) (isRect ? fills : shapes).push({ box: b, color: hex(gs.fill) });
        }
        if (doStroke) {
          if (isRect) {
            rule(b[0], b[1], b[2], b[1], lw, hex(gs.stroke)); rule(b[0], b[3], b[2], b[3], lw, hex(gs.stroke));
            rule(b[0], b[1], b[0], b[3], lw, hex(gs.stroke)); rule(b[2], b[1], b[2], b[3], lw, hex(gs.stroke));
          } else if (!sp.curved && pts.every((p, j) => !j || Math.abs(p[0] - pts[j - 1][0]) < 0.5 || Math.abs(p[1] - pts[j - 1][1]) < 0.5)) {
            for (let j = 1; j < pts.length; j++) rule(pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1], lw, hex(gs.stroke));
          } else if (!whiteish(gs.stroke)) shapes.push({ box: b, color: hex(gs.stroke) });
        }
      }
    }
  }
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i], q = boxes[j];
        if (p[0] <= q[2] + 1 && q[0] <= p[2] + 1 && p[1] <= q[3] + 1 && q[1] <= p[3] + 1) {
          boxes[i] = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])];
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  const area = vp.width * vp.height;
  const images = boxes.map((b) => ({ box: b, full: (b[2] - b[0]) * (b[3] - b[1]) > area * 0.85 }));
  // A full-page picture keeps where it came from, to be taken out on its own (see backgroundJpeg).
  for (const im of images) if (im.full) Object.assign(im, srcs.find((x) => (x.box[2] - x.box[0]) * (x.box[3] - x.box[1]) > area * 0.85) || {}, { box: im.box });
  return { images, dots, rules, fills, shapes: shapes.slice(0, 4000) };
}

/* ---------- lines, segments and runs ---------- */

const sameStyle = (a, b) => a.bold === b.bold && a.italic === b.italic && a.color === b.color && a.link === b.link
  && a.font === b.font && a.hidden === b.hidden && Math.abs(a.size - b.size) < 0.6;
const segText = (sg) => sg.runs.map((r) => r.text).join('');
const lineText = (l) => l.segs.map(segText).join(' ');
const runsText = (runs) => runs.map((r) => r.text).join('');
const joinSegs = (segs) => segs.flatMap((sg, k) => (k ? [{ ...sg.runs[0], text: ' ' }, ...sg.runs] : sg.runs)).map((r) => ({ ...r }));

// Pieces on the same baseline make a line. A wide gap splits a line into
// segments: table cells, or a label and its value.
function toLines(items) {
  const groups = [];
  for (const it of items.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(it.y - g.y) < Math.min(g.size, it.size) * 0.4) g.items.push(it);
    else groups.push({ y: it.y, size: it.size, items: [it] });
  }
  return groups.map((g) => {
    const its = g.items.sort((a, b) => a.x - b.x);
    const segs = [];
    let seg = null, prev = null;
    for (const it of its) {
      // Some PDFs fake bold by drawing the same text twice, a hair apart.
      if (prev && it.str === prev.str && Math.abs(it.x - prev.x) < it.size * 0.2) continue;
      const gap = prev ? it.x - (prev.x + prev.w) : 0;
      if (!seg || gap > Math.max(prev.size, it.size) * 0.9) {
        seg = { x0: it.x, x1: it.x + it.w, runs: [] };
        segs.push(seg);
      } else if (gap > it.size * 0.12 && !/\s$/.test(seg.runs[seg.runs.length - 1].text) && !/^\s/.test(it.str)) {
        seg.runs[seg.runs.length - 1].text += ' ';
      }
      const last = seg.runs[seg.runs.length - 1];
      if (last && sameStyle(last, it)) last.text += it.str;
      else seg.runs.push({ text: it.str, bold: it.bold, italic: it.italic, size: it.size, color: it.color, font: it.font, link: it.link, hidden: it.hidden });
      seg.x1 = Math.max(seg.x1, it.x + it.w);
      prev = it;
    }
    for (const sg of segs) tidy(sg.runs);
    // A list marker drawn apart from its text belongs with it.
    if (segs.length > 1 && MARKER.test(segText(segs[0]))) {
      segs[0].runs[segs[0].runs.length - 1].text += ' ';
      segs[1].runs.unshift(...segs[0].runs);
      segs[1].x0 = segs[0].x0;
      segs.shift();
    }
    const chars = new Map();
    for (const it of its) chars.set(it.size, (chars.get(it.size) || 0) + it.str.length);
    const size = [...chars].sort((a, b) => b[1] - a[1])[0][0];
    const runs = segs.flatMap((sg) => sg.runs);
    return {
      y: g.y, size, segs, x0: segs[0].x0, x1: Math.max(...segs.map((sg) => sg.x1)),
      top: g.y - size * 0.9, bottom: g.y + size * 0.25, bold: runs.every((r) => r.bold),
    };
  });
}

// Collapses spaces and trims the ends of a run list.
function tidy(runs) {
  runs.forEach((r) => (r.text = r.text.replace(/\s+/g, ' ')));
  for (let k = 1; k < runs.length; k++) if (/ $/.test(runs[k - 1].text) && /^ /.test(runs[k].text)) runs[k].text = runs[k].text.slice(1);
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart();
    runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
  }
  return runs;
}

function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text && !r.br) continue;
    const last = out[out.length - 1];
    if (last && !r.br && !last.br && sameStyle(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

// The runs of several lines as one paragraph: lines joined with a space, and
// a word broken with a hyphen at the end of a line put back together. With
// `breaks`, a line broken on purpose (l.br) starts on a new line.
function blockRuns(lines, breaks = false) {
  const out = [];
  lines.forEach((l, k) => {
    const runs = joinSegs(l.segs);
    if (k && out.length && runs.length) {
      const last = out[out.length - 1];
      if (breaks && l.br) out.push({ ...last, text: '', br: true, link: null });
      else if (/­$/.test(last.text)) last.text = last.text.slice(0, -1);
      else if (/\p{L}-$/u.test(last.text) && /^\p{Ll}/u.test(runs[0].text)) last.text = last.text.slice(0, -1);
      else last.text += ' ';
    }
    out.push(...runs);
  });
  return mergeRuns(tidy(out));
}

// Takes `n` characters off the front of a run list (a list marker).
function dropFront(runs, n) {
  const out = runs.map((r) => ({ ...r }));
  while (n > 0 && out.length) {
    const take = Math.min(n, out[0].text.length);
    out[0].text = out[0].text.slice(take);
    n -= take;
    if (!out[0].text) out.shift();
  }
  return tidy(out);
}

/* ---------- blocks: paragraphs, tables, pictures ---------- */

// Consecutive lines that each have two or more segments, whose segments line
// up in columns, are a table. Columns are the union of the segments' spans,
// so left, right and centered cells all land in the right column.
function tableAt(lines, i) {
  let j = i;
  while (j < lines.length && lines[j].segs.length >= 2 && (j === i || lines[j].y - lines[j - 1].y < lines[j - 1].size * 3)) j++;
  if (j - i < 2) return null;
  const rows = lines.slice(i, j);
  const spans = rows.flatMap((l) => l.segs.map((sg) => [sg.x0, sg.x1])).sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const [a, b] of spans) {
    const c = cols[cols.length - 1];
    if (c && a <= c.x1 + 2) c.x1 = Math.max(c.x1, b);
    else cols.push({ x0: a, x1: b });
  }
  if (cols.length < 2) return null;
  const segs = rows.flatMap((l) => l.segs);
  if (segs.reduce((s, sg) => s + segText(sg).length, 0) / segs.length > 40) return null; // two columns of prose, not a table
  const cells = rows.map((l) => cols.map((c) => tidy(joinSegs(l.segs.filter((sg) => sg.x0 >= c.x0 - 1 && sg.x1 <= c.x1 + 1)))));
  return {
    type: 'table', end: j, cols, cells,
    x0: cols[0].x0, x1: cols[cols.length - 1].x1, top: rows[0].top, bottom: rows[rows.length - 1].bottom,
  };
}

// Whether line `l` carries on the paragraph `b`: false, true, or 'br' when it
// does after a line break made on purpose (the line before had room for this
// line's first word, as in an address). `width` is how wide the text runs.
function continues(b, l, lead, width) {
  const go = carriesOn(b, l, lead);
  if (!go || !width) return go;
  const p = b.lines[b.lines.length - 1];
  const text = lineText(l);
  const first = (l.x1 - l.x0) * ((text.indexOf(' ') + 1 || text.length) / Math.max(1, text.length));
  return width - (p.x1 - p.x0) > first + l.size ? 'br' : true;
}

function carriesOn(b, l, lead) {
  const p = b.lines[b.lines.length - 1];
  if (Math.abs(l.size - p.size) > p.size * 0.12) return false;
  if (l.y - p.y > Math.max(lead, p.size * 1.05) * 1.35) return false;
  if (BULLET.test(lineText(l)) || NUMBERED.test(lineText(l))) return false;
  if (l.x1 < p.x0 || l.x0 > p.x1) return false; // another column
  if (p.bold !== l.bold) return false;
  if (b.list) return l.x0 > b.lines[0].x0 + 1; // an item's next lines start past its marker
  const left = b.lines.length > 1 ? Math.min(...b.lines.slice(1).map((x) => x.x0)) : b.lines[0].x0;
  if (l.x0 > left + l.size) return false; // an indented first line starts a paragraph
  if (b.lines.length > 1 && l.x0 < left - l.size) return false;
  const right = Math.max(...b.lines.map((x) => x.x1));
  if (b.lines.length > 1 && /[.!?:]["”’)]?$/.test(lineText(p)) && p.x1 < right - l.size * 4) return false;
  return true;
}

function textBlock(line) {
  const text = lineText(line);
  const m = text.match(BULLET) || text.match(NUMBERED);
  return {
    type: 'text', lines: [line], size: line.size,
    list: m ? { ordered: !BULLET.test(text), marker: m[0], x: line.x0, level: 0 } : null,
  };
}

const boxOf = (it) => [it.x, it.y - it.size * 0.85, it.x + it.w, it.y + it.size * 0.25];
const centerOf = (it) => [it.x + it.w / 2, it.y - it.size * 0.35];
const within = (p, b, tol = 1) => p[0] >= b[0] - tol && p[0] <= b[2] + tol && p[1] >= b[1] - tol && p[1] <= b[3] + tol;
const areaOf = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlapArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const textEl = (it) => { const b = boxOf(it); return { kind: 'text', it, x0: b[0], top: b[1], x1: b[2], bottom: b[3], size: it.size }; };
const flatBlocks = (blocks) => blocks.flatMap((b) => (b.type === 'cols' ? b.cols.flatMap((c) => flatBlocks(c.blocks)) : [b]));
const mostCommon = (list) => [...list.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0]?.[0];

function unionFind(n) {
  const p = [...Array(n).keys()];
  const find = (x) => { while (p[x] !== x) x = p[x] = p[p[x]]; return x; };
  return { find, union: (a, b) => { p[find(a)] = find(b); } };
}

// Positions closer than `tol` become one (their average).
function cluster(vals, tol) {
  const out = [];
  for (const v of vals.slice().sort((a, b) => a - b)) {
    const c = out[out.length - 1];
    if (c && v - c.max <= tol) { c.max = v; c.sum += v; c.n++; } else out.push({ max: v, sum: v, n: 1 });
  }
  return out.map((c) => c.sum / c.n);
}

// Tables drawn with lines: a set of crossing horizontal and vertical lines
// is a grid. A missing line between two squares merges them into one cell.
// The text in each cell is laid out on its own; a filled box under a cell
// is its shading.
function gridTables(pg, items) {
  const merge = (list) => {
    const out = [];
    for (const r of list.slice().sort((a, b) => a.pos - b.pos || a.from - b.from)) {
      const o = out.find((q) => Math.abs(q.pos - r.pos) <= 1.5 && r.from <= q.to + 2 && r.to >= q.from - 2);
      if (o) { o.from = Math.min(o.from, r.from); o.to = Math.max(o.to, r.to); } else out.push({ ...r });
    }
    return out;
  };
  const Hs = merge(pg.rules.filter((r) => r.dir === 'h')), Vs = merge(pg.rules.filter((r) => r.dir === 'v'));
  if (Hs.length < 2 || Vs.length < 2 || Hs.length * Vs.length > 400000) return [];
  const all = [...Hs, ...Vs];
  const uf = unionFind(all.length);
  Hs.forEach((hr, i) => Vs.forEach((vr, j) => {
    if (vr.pos >= hr.from - 2 && vr.pos <= hr.to + 2 && hr.pos >= vr.from - 2 && hr.pos <= vr.to + 2) uf.union(i, Hs.length + j);
  }));
  const comps = new Map();
  all.forEach((r, i) => { const k = uf.find(i); if (!comps.has(k)) comps.set(k, []); comps.get(k).push(r); });
  const tables = [];
  const taken = new Set();
  for (const rs of comps.values()) {
    const H = rs.filter((r) => r.dir === 'h'), V = rs.filter((r) => r.dir === 'v');
    if (H.length < 2 || V.length < 2) continue;
    const xs = cluster(V.map((r) => r.pos), 3), ys = cluster(H.map((r) => r.pos), 3);
    if (xs.length < 2 || ys.length < 2) continue;
    const box = [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]];
    if (xs.length === 2 && ys.length === 2 && areaOf(box) > pg.w * pg.h * 0.4) continue; // a frame round the page
    const inTable = items.filter((it) => !taken.has(it) && within(centerOf(it), box, 0.5));
    if (!inTable.length) continue; // a drawing, not a table
    const covered = (list, pos, a, b) => {
      let len = 0;
      for (const r of list) if (Math.abs(r.pos - pos) <= 3) len += Math.max(0, Math.min(b, r.to) - Math.max(a, r.from));
      return len >= (b - a) * 0.6;
    };
    const nr = ys.length - 1, nc = xs.length - 1;
    const g = unionFind(nr * nc);
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      if (c + 1 < nc && !covered(V, xs[c + 1], ys[r], ys[r + 1])) g.union(r * nc + c, r * nc + c + 1);
      if (r + 1 < nr && !covered(H, ys[r + 1], xs[c], xs[c + 1])) g.union(r * nc + c, (r + 1) * nc + c);
    }
    // Cells are groups of squares; a group that isn't a rectangle stays as squares.
    const groups = new Map();
    for (let k = 0; k < nr * nc; k++) { const root = g.find(k); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(k); }
    const cellOf = new Array(nr * nc);
    const cells = [];
    for (const ks of groups.values()) {
      const rows = ks.map((k) => Math.floor(k / nc)), cols = ks.map((k) => k % nc);
      const r0 = Math.min(...rows), r1 = Math.max(...rows), c0 = Math.min(...cols), c1 = Math.max(...cols);
      const parts = (r1 - r0 + 1) * (c1 - c0 + 1) === ks.length ? [[r0, r1, c0, c1, ks]] : ks.map((k) => [Math.floor(k / nc), Math.floor(k / nc), k % nc, k % nc, [k]]);
      for (const [a, b, c, d, kk] of parts) {
        const cell = { r0: a, r1: b, c0: c, c1: d, items: [] };
        cells.push(cell);
        kk.forEach((k) => (cellOf[k] = cell));
      }
    }
    const at = (list, v) => { let i = 0; while (i < list.length - 2 && v >= list[i + 1]) i++; return i; };
    for (const it of inTable) {
      cellOf[at(ys, centerOf(it)[1]) * nc + at(xs, it.x + Math.min(it.w / 2, it.size))].items.push(it);
      taken.add(it);
    }
    for (const cell of cells) {
      const b = [xs[cell.c0], ys[cell.r0], xs[cell.c1 + 1], ys[cell.r1 + 1]];
      const mid = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      cell.box = b;
      cell.fill = pg.fills.filter((f) => within(mid, f.box, 0) && overlapArea(f.box, b) >= areaOf(b) * 0.5)
        .sort((p, q) => areaOf(p.box) - areaOf(q.box))[0]?.color || null;
      cell.edges = { top: covered(H, b[1], b[0], b[2]), bottom: covered(H, b[3], b[0], b[2]), left: covered(V, b[0], b[1], b[3]), right: covered(V, b[2], b[1], b[3]) };
      cell.blocks = cell.items.length ? flowBlocks(cell.items.map(textEl), pg, b[2] - b[0] - 8) : [];
      cell.runs = cell.items.length ? blockRuns(toLines(cell.items)) : [];
    }
    cells.sort((p, q) => p.r0 - q.r0 || p.c0 - q.c0);
    // As rows and columns of text too, for Excel and Markdown.
    const grid = Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => {
      const cell = cellOf[r * nc + c];
      return cell.r0 === r && cell.c0 === c ? cell.runs : [];
    }));
    tables.push({
      type: 'table', ruled: true, xs, ys, cellList: cells, cells: grid, cols: xs.slice(0, -1).map((x, c) => ({ x0: x, x1: xs[c + 1] })),
      x0: box[0], x1: box[2], top: box[1], bottom: box[3],
      color: mostCommon(rs.map((r) => r.color)) || '#000000', width: median(rs.map((r) => r.width)) || 0.75,
    });
  }
  return tables;
}

// Vector drawings away from the text (logos, icons, charts) become pictures,
// together with the embedded images. A filled box with text on it is the
// text's background instead. A small drawing with only a few words on it
// (a logo with its name) is a picture, words included.
function pictures(pg, items, tables) {
  const pageArea = pg.w * pg.h;
  const inTable = (b) => tables.some((t) => within([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], [t.x0, t.top, t.x1, t.bottom], 0));
  const centers = items.map(centerOf);
  const panels = [], parts = [];
  for (const f of pg.fills) {
    if (inTable(f.box) || areaOf(f.box) > pageArea * 0.5) continue;
    if (centers.some((c) => within(c, f.box, 0))) panels.push(f); else parts.push(f.box);
  }
  for (const s of pg.shapes) if (!inTable(s.box) && areaOf(s.box) < pageArea * 0.5) parts.push(s.box);
  const near = (p, q, d) => p[0] <= q[2] + d && q[0] <= p[2] + d && p[1] <= q[3] + d && q[1] <= p[3] + d;
  const join = (list, d) => {
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < list.length; i++) for (let j = list.length - 1; j > i; j--) {
        if (!near(list[i].box, list[j].box, d)) continue;
        const p = list[i].box, q = list[j].box;
        list[i] = { box: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])], n: list[i].n + list[j].n };
        list.splice(j, 1);
        merged = true;
      }
    }
    return list;
  };
  const groups = join(parts.map((b) => ({ box: [...b], n: 1 })), 6);
  const used = new Set();
  const pics = [];
  for (const g of groups) {
    const b = g.box, w = b[2] - b[0], hh = b[3] - b[1];
    if (w < 6 || hh < 6 || w * hh < 80 || (g.n === 1 && w <= 9 && hh <= 9)) continue; // specks and lone bullets
    const inside = items.filter((it, k) => within(centers[k], b, 0));
    if (inside.length) {
      if (g.n < 3 || inside.reduce((s, it) => s + it.str.length, 0) > 40) continue;
      inside.forEach((it) => used.add(it));
    }
    pics.push({ box: [...b], n: g.n });
  }
  for (const im of pg.images) if (!im.full) pics.push({ box: [...im.box], n: 1 });
  return { pics: join(pics, 2).map((p) => p.box), used, panels };
}

function layoutPage(pg) {
  // A picture filling the page behind real text is its background; behind
  // only an OCR layer it is a scan, and the recognized text is what counts.
  const full = pg.images.find((im) => im.full);
  pg.background = full && pg.items.some((it) => !it.hidden) ? full : null;
  const tables = gridTables(pg, pg.items);
  const taken = new Set(tables.flatMap((t) => t.cellList.flatMap((c) => c.items)));
  let items = pg.items.filter((it) => !taken.has(it));
  const { pics, used, panels } = pictures(pg, items, tables);
  items = items.filter((it) => !used.has(it));
  pg.panels = panels;
  pg.flow = layoutRegion([
    ...items.map(textEl),
    ...pics.map((b) => ({ kind: 'image', x0: b[0], top: b[1], x1: b[2], bottom: b[3] })),
    ...tables.map((t) => ({ kind: 'table', t, x0: t.x0, top: t.top, x1: t.x1, bottom: t.bottom })),
  ], pg, 0);
  pg.blocks = flatBlocks(pg.flow);
}

// Lays out a part of the page. Pieces side by side with a clear gap between
// them over several lines (a logo beside an address, two columns) become
// columns, each laid out on its own; when their lines line up row by row
// they are a table instead. Everything else flows top to bottom. `width` is
// how wide the space for it is in the document.
function layoutRegion(els, pg, depth, width = 0) {
  if (!els.length) return [];
  const sorted = els.slice().sort((a, b) => a.top - b.top || a.x0 - b.x0);
  width ||= Math.max(...els.map((e) => e.x1)) - Math.min(...els.map((e) => e.x0));
  const bands = [];
  for (const e of sorted) {
    const b = bands[bands.length - 1];
    if (b && e.top < b.bottom - 0.5) { b.els.push(e); b.bottom = Math.max(b.bottom, e.bottom); } else bands.push({ top: e.top, bottom: e.bottom, els: [e] });
  }
  const body = median(sorted.filter((e) => e.kind === 'text').map((e) => e.size)) || 11;
  const G = Math.max(12, body * 1.4);
  const gaps = (band) => {
    const occ = [];
    for (const [a, b] of band.els.map((e) => [e.x0, e.x1]).sort((p, q) => p[0] - q[0])) {
      const c = occ[occ.length - 1];
      if (c && a <= c[1]) c[1] = Math.max(c[1], b); else occ.push([a, b]);
    }
    const out = [];
    for (let k = 1; k < occ.length; k++) if (occ[k][0] - occ[k - 1][1] >= G) out.push([occ[k - 1][1], occ[k][0]]);
    return out;
  };
  // A gutter narrowed to what `band` leaves free; null once something crosses it.
  const narrow = (gu, band) => {
    let [lo, hi] = gu;
    for (const e of band.els) {
      if (e.x1 <= lo || e.x0 >= hi) continue;
      if (e.x0 - lo >= hi - e.x1) hi = Math.min(hi, e.x0); else lo = Math.max(lo, e.x1);
      if (hi - lo < G * 0.6) return null;
    }
    return [lo, hi];
  };
  const out = [];
  let flow = [];
  const flush = () => { if (flow.length) out.push(...flowBlocks(flow, pg, width)); flow = []; };
  for (let i = 0; i < bands.length;) {
    let gs = depth < 2 ? gaps(bands[i]) : [];
    if (!gs.length) { flow.push(...bands[i].els); i++; continue; }
    let j = i + 1, bottom = bands[i].bottom;
    while (j < bands.length) {
      // A line on one side only carries on the columns when it follows
      // closely (a column running longer); after a gap it starts something new.
      const gap = bands[j].top - bottom;
      if (gap >= body * 2.2 || (gap >= body * 0.6 && !gaps(bands[j]).length)) break;
      const keep = gs.map((gu) => narrow(gu, bands[j])).filter(Boolean);
      if (!keep.length) break;
      gs = keep;
      bottom = Math.max(bottom, bands[j].bottom);
      j++;
    }
    const part = bands.slice(i, j).flatMap((b) => b.els);
    // One line of text with a wide gap is a label and its value: the line's own segments handle it.
    if (j - i === 1 && part.every((e) => e.kind === 'text')) { flow.push(...part); i = j; continue; }
    flush();
    out.push(splitColumns(part, gs, pg, depth));
    i = j;
  }
  flush();
  return out.sort((a, b) => a.top - b.top);
}

function splitColumns(els, gutters, pg, depth) {
  const x0 = Math.min(...els.map((e) => e.x0)), x1 = Math.max(...els.map((e) => e.x1));
  const top = Math.min(...els.map((e) => e.top)), bottom = Math.max(...els.map((e) => e.bottom));
  if (els.every((e) => e.kind === 'text')) {
    const lines = toLines(els.map((e) => e.it));
    const t = lines.length >= 2 && tableAt(lines, 0);
    if (t && t.end === lines.length) return { ...t, aligned: true };
  }
  const edges = [x0, ...gutters.map((g) => (g[0] + g[1]) / 2).sort((a, b) => a - b), x1];
  const cols = edges.slice(0, -1).map((a, k) => ({ x0: a, x1: edges[k + 1], els: [] }));
  for (const e of els) {
    const cx = (e.x0 + e.x1) / 2;
    (cols.find((c) => cx < c.x1) || cols[cols.length - 1]).els.push(e);
  }
  return { type: 'cols', x0, x1, top, bottom, cols: cols.filter((c) => c.els.length).map((c) => ({ x0: c.x0, x1: c.x1, blocks: layoutRegion(c.els, pg, depth + 1, c.x1 - c.x0) })) };
}

// Text, pictures and tables in one column, top to bottom: lines become
// paragraphs, lists and tables of lined-up text.
function flowBlocks(els, pg, room = 0) {
  const blocks = [];
  const items = els.filter((e) => e.kind === 'text').map((e) => e.it);
  if (items.length) {
    const lines = toLines(items);
    // A dot just left of a line, at its middle, is the line's bullet.
    for (const l of lines) {
      const dot = pg.dots.find((d) => d[2] <= l.x0 && l.x0 - d[2] < l.size * 2 && Math.abs((d[1] + d[3]) / 2 - (l.y - l.size * 0.33)) < l.size * 0.3);
      if (!dot) continue;
      const sg = l.segs[0];
      sg.runs.unshift({ ...sg.runs[0], text: '• ', link: null });
      sg.x0 = l.x0 = dot[0];
    }
    const gaps = [];
    for (let k = 1; k < lines.length; k++) {
      const d = lines[k].y - lines[k - 1].y;
      if (Math.abs(lines[k].size - lines[k - 1].size) < 0.6 && d > 0 && d < lines[k].size * 2.5) gaps.push(d);
    }
    // Line spacing; capped, because a page of one-line paragraphs only shows paragraph gaps.
    const lead = Math.min(median(gaps) || 14, median(lines.map((l) => l.size)) * 1.5);
    const width = room || Math.max(...lines.map((l) => l.x1)) - Math.min(...lines.map((l) => l.x0));
    const start = blocks.length;
    for (let i = 0; i < lines.length;) {
      const t = tableAt(lines, i);
      if (t) { blocks.push({ ...t, aligned: true }); i = t.end; continue; }
      const b = blocks[blocks.length - 1];
      const go = b?.type === 'text' && continues(b, lines[i], lead, width);
      if (go) { lines[i].br = go === 'br'; b.lines.push(lines[i]); } else blocks.push(textBlock(lines[i]));
      i++;
    }
    const texts = blocks.slice(start).filter((b) => b.type === 'text');
    for (const b of texts) {
      b.x0 = Math.min(...b.lines.map((l) => l.x0));
      b.x1 = Math.max(...b.lines.map((l) => l.x1));
      b.top = b.lines[0].top;
      b.bottom = b.lines[b.lines.length - 1].bottom;
      const mid = [(b.x0 + b.x1) / 2, (b.top + b.bottom) / 2];
      b.shade = (pg.panels || []).filter((f) => within(mid, f.box, 1)).sort((p, q) => areaOf(p.box) - areaOf(q.box))[0]?.color || null;
    }
    // How deep a list item sits, from how far its marker is indented.
    const xs = [...new Set(texts.filter((b) => b.list).map((b) => Math.round(b.list.x / 4)))].sort((a, b) => a - b);
    for (const b of texts) if (b.list) b.list.level = Math.min(2, xs.indexOf(Math.round(b.list.x / 4)));
  }
  for (const e of els) {
    if (e.kind === 'image') blocks.push({ type: 'image', x0: e.x0, x1: e.x1, top: e.top, bottom: e.bottom });
    else if (e.kind === 'table') blocks.push(e.t);
  }
  return blocks.sort((a, b) => a.top - b.top);
}

// Body text size is the size most characters have; bigger short blocks are
// headings, ranked by size across the document (largest = level 1).
function layoutDoc(pages) {
  pages.forEach(layoutPage);
  const chars = new Map();
  for (const pg of pages) for (const it of pg.items) {
    const k = Math.round(it.size * 2) / 2;
    chars.set(k, (chars.get(k) || 0) + it.str.length);
  }
  const body = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] || 12;
  const isHead = (b) => b.type === 'text' && !b.list && b.lines.length <= 3 && b.size >= body * 1.15;
  const sizes = [...new Set(pages.flatMap((pg) => pg.blocks.filter(isHead).map((b) => Math.round(b.size * 2) / 2)))].sort((a, b) => b - a);
  for (const pg of pages) for (const b of pg.blocks) if (isHead(b)) b.level = Math.min(3, sizes.indexOf(Math.round(b.size * 2) / 2) + 1);
  return body;
}

async function readDoc(doc, progress) {
  const lib = await loadLib(doc).catch(() => null);
  const pages = [];
  for (let i = 0; i < doc.pages; i++) {
    progress(i, doc.pages);
    await tick();
    pages.push(await readPdfPage(doc, i, lib));
  }
  return { pages, body: layoutDoc(pages) };
}

const readingProgress = (i, n) => busy(n > 1 ? `Reading page ${i + 1} of ${n}…` : 'Reading the page…');

/* ---------- numbers ---------- */

// "1,234.56", "(123)", "-4.5%", "$12" -> a number, and an Excel format that
// shows it the same way. Codes with leading zeros stay text.
function toNumber(s) {
  let t = s.trim().replace(/−/g, '-');
  let neg = false, paren = false;
  if (/^\(.+\)$/.test(t)) { neg = paren = true; t = t.slice(1, -1).trim(); }
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1).trim(); }
  const cur = t.match(/^[$€£¥₹]/)?.[0] || '';
  if (cur) t = t.slice(1).trim();
  if (cur && t.startsWith('-')) { neg = !neg; t = t.slice(1).trim(); }
  const pct = t.endsWith('%');
  if (pct) t = t.slice(0, -1).trim();
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^\.\d+$/.test(t) || /^0\d/.test(t)) return null;
  // Over 15 digits loses precision in Excel; 10+ bare digits is an ID, card or phone number.
  const digits = t.split('.')[0].replace(/,/g, '');
  if (digits.length > 15 || (!/[,.]/.test(t) && !cur && !pct && digits.length >= 10)) return null;
  const commas = t.includes(',');
  const dec = (t.split('.')[1] || '').length;
  let v = parseFloat(t.replace(/,/g, ''));
  if (neg) v = -v;
  if (pct) v = +(v / 100).toFixed(dec + 2);
  if (!commas && !pct && !cur && !paren && !dec) return { v };
  let z = (commas ? '#,##0' : '0') + (dec ? '.' + '0'.repeat(dec) : '');
  if (pct) z += '%';
  if (cur) z = `"${cur}"${z}`;
  if (paren) z = `${z};(${z})`;
  return { v, z };
}

/* ---------- pictures from page renders ---------- */

// Crops each picture area out of a 144 dpi render of the page. Cropping the
// render works for every kind of image a PDF can hold.
async function cropAreas(doc, i, areas) {
  if (!areas.length) return [];
  const k = 2;
  const c = await renderPage(doc.js, i, 0, { lazy: false, scale: k });
  const out = [];
  for (const a of areas) {
    const w = Math.max(1, Math.round((a.x1 - a.x0) * k)), hh = Math.max(1, Math.round((a.bottom - a.top) * k));
    const part = document.createElement('canvas');
    part.width = w; part.height = hh;
    const x = part.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, w, hh);
    x.drawImage(c, Math.round(a.x0 * k), Math.round(a.top * k), w, hh, 0, 0, w, hh);
    const jpg = w * hh > 400000;
    const blob = await new Promise((r) => part.toBlob(r, jpg ? 'image/jpeg' : 'image/png', 0.9));
    out.push({ bytes: new Uint8Array(await blob.arrayBuffer()), type: jpg ? 'jpg' : 'png' });
  }
  c.width = c.height = 0;
  return out;
}

// A page as a JPEG on white paper.
async function pageJpeg(js, i, scale, quality = 0.88) {
  const c = await renderPage(js, i, 0, { lazy: false, scale });
  const w = document.createElement('canvas');
  w.width = c.width; w.height = c.height;
  const x = w.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, w.width, w.height);
  x.drawImage(c, 0, 0);
  c.width = c.height = 0;
  const blob = await new Promise((r) => w.toBlob(r, 'image/jpeg', quality));
  w.width = w.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}

const pageList = (nums) => (nums.length === 1 ? `Page ${nums[0]}` : `Pages ${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`);

/* ---------- PDF -> WORD ---------- */

const tw = (pt) => Math.round(pt * 20); // twips
const px = (pt) => Math.round((pt * 96) / 72);

const pdfToWord = {
  id: 'pdf-to-word', keywords: 'docx doc word convert editable office microsoft', title: 'PDF to Word', icon: 'toWord', color: '#2563eb', cat: 'convert',
  action: 'Convert to Word', busyText: 'Converting…',
  desc: 'Turn a PDF into an editable Word document.',
  long: 'Rebuilds paragraphs, headings, lists, tables with their borders and shading, logos, pictures and filled-in form fields as an editable .docx. Text side by side, like a logo beside an address or two columns, stays side by side.',
  setup(ctx) {
    ctx.state = { mode: 'text' };
    ctx.main.append(fileHero(ctx.items[0]));
    ctx.side.append(
      choiceCards([
        ['text', 'Editable text', 'Paragraphs, headings and tables you can edit'],
        ['look', 'Exact look', 'Each page as a picture. Best for scans'],
      ], 'text', (v) => (ctx.state.mode = v)),
      h('p', {}, 'Scanned pages have no text to rebuild. Run OCR on them first, or pick Exact look.'));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    await loadScript('vendor/docx/docx.min.js');
    const D = window.docx;
    const sections = [];
    const scans = [];
    let body = 12;
    let font = 'Arial';
    if (ctx.state.mode === 'look') {
      for (let i = 0; i < doc.pages; i++) {
        busy(`Page ${i + 1} of ${doc.pages}…`);
        await tick();
        const { width: W, height: H } = (await doc.js.getPage(i + 1)).getViewport({ scale: 1 });
        const data = await pageJpeg(doc.js, i, 2.2);
        sections.push({
          properties: { page: { size: { width: tw(W), height: tw(H) }, margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 } } },
          children: [new D.Paragraph({ children: [new D.ImageRun({
            type: 'jpg', data, transformation: { width: px(W), height: px(H) },
            // Floating at the page corner, so a full-size picture never pushes onto a new page.
            floating: { horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.PAGE, offset: 0 }, verticalPosition: { relative: D.VerticalPositionRelativeFrom.PAGE, offset: 0 }, behindDocument: true },
          })] })],
        });
      }
    } else {
      const read = await readDoc(doc, readingProgress);
      body = read.body;
      font = commonFont(read.pages, body);
      for (const [i, pg] of read.pages.entries()) {
        busy(`Building page ${i + 1} of ${doc.pages}…`);
        await tick();
        if (!pg.items.length) scans.push(i + 1);
        sections.push(await wordSection(D, doc, i, pg));
      }
    }
    busy('Saving…');
    await tick();
    const file = new D.Document({
      creator: 'PDF Tools',
      styles: { default: { document: { run: { font, size: Math.round(body * 2) } } } },
      sections,
    });
    const blob = await D.Packer.toBlob(file);
    let note = ctx.state.mode === 'look' ? 'Each page is a picture, so the text is not editable.' : 'Fonts and spacing are close to the PDF, not identical. Check the layout in Word.';
    if (scans.length === doc.pages) note = 'This PDF has no text, it looks like a scan. The pages are in the document as pictures. Run OCR first to get editable text.';
    else if (scans.length) note = `${pageList(scans)} had no text (scanned), so ${scans.length === 1 ? 'it is' : 'they are'} in the document as ${scans.length === 1 ? 'a picture' : 'pictures'}. Run OCR first to edit ${scans.length === 1 ? 'it' : 'them'}.`;
    return { files: [{ name: `${baseName(doc.name)}.docx`, bytes: blob, type: MIME.docx }], title: 'Your Word document is ready', note };
  },
};

function commonFont(pages, body) {
  const n = new Map();
  for (const pg of pages) for (const it of pg.items) if (Math.abs(it.size - body) < 1) n.set(it.font, (n.get(it.font) || 0) + it.str.length);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Arial';
}

// One Word section per page, so each keeps its own size; margins come from
// where the content sits.
async function wordSection(D, doc, i, pg) {
  const W = pg.w, H = pg.h;
  const size = { width: tw(W), height: tw(H) };
  if (!pg.items.length) {
    // A scan: keep it as a picture so nothing is lost.
    const m = 36;
    const k = Math.min((W - 2 * m) / W, (H - 2 * m) / H);
    const data = await pageJpeg(doc.js, i, 2);
    return {
      properties: { page: { size, margin: { top: tw(m), right: tw(m), bottom: tw(m), left: tw(m) } } },
      children: [new D.Paragraph({ children: [new D.ImageRun({ type: 'jpg', data, transformation: { width: px(W * k), height: px(H * k) } })] })],
    };
  }
  const bs = pg.flow;
  const left = clamp(Math.min(...bs.map((b) => b.x0)), 18, 108);
  const right = clamp(W - Math.max(...bs.map((b) => b.x1)), 18, 108);
  const top = clamp(Math.min(...bs.map((b) => b.top)), 18, 108);
  // Some slack at the bottom: Word sets lines a little taller than the PDF did, and a page that overflows makes an extra page.
  const bottom = clamp(H - Math.max(...bs.map((b) => b.bottom)) - 24, 14, 54);
  // Pictures anywhere on the page, also inside columns.
  const imgs = [];
  const walk = (list) => list.forEach((b) => (b.type === 'image' ? imgs.push(b) : b.type === 'cols' && b.cols.forEach((c) => walk(c.blocks))));
  walk(bs);
  const crops = await cropAreas(doc, i, imgs);
  imgs.forEach((b, k) => (b.pic = crops[k]));
  const children = wordBlocks(D, bs, { left, right: W - right, top });
  const bg = pg.background && await backgroundJpeg(doc, i, pg.background);
  if (bg) {
    // The page's background picture, behind the text where it was on the page.
    const [x0, y0, x1, y1] = pg.background.box;
    const emu = (pt) => Math.round(pt * 12700);
    children.unshift(new D.Paragraph({
      spacing: { before: 0, after: 0, line: 20, lineRule: D.LineRuleType.EXACT },
      children: [new D.ImageRun({
        type: 'jpg', data: bg, transformation: { width: px(x1 - x0), height: px(y1 - y0) },
        floating: { horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.PAGE, offset: emu(x0) }, verticalPosition: { relative: D.VerticalPositionRelativeFrom.PAGE, offset: emu(y0) }, behindDocument: true },
      })],
    }));
  }
  return { properties: { page: { size, margin: { top: tw(top), right: tw(right), bottom: tw(bottom), left: tw(left) } } }, children };
}

// The page's full-size background image itself, without the text drawn on
// it (a render of the page would have the text twice). Null if pdf.js
// doesn't hand it over, or it is turned.
async function backgroundJpeg(doc, i, bg) {
  const { src, m } = bg;
  if (!src || !m || Math.abs(m[1]) > 0.01 || Math.abs(m[2]) > 0.01) return null;
  const page = await doc.js.getPage(i + 1);
  let img = src;
  if (typeof src === 'string') {
    const objs = src.startsWith('g_') ? page.commonObjs : page.objs;
    img = await Promise.race([new Promise((res) => { try { objs.get(src, res); } catch { res(null); } }), new Promise((res) => setTimeout(() => res(null), 3000))]);
  }
  if (!img?.width || !img?.height) return null;
  let c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  if (img.bitmap) x.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const n = img.width * img.height, d = img.data, rgba = new Uint8ClampedArray(n * 4);
    if (img.kind === 3) rgba.set(d.subarray(0, n * 4));
    else if (img.kind === 2) for (let p = 0; p < n; p++) { rgba[p * 4] = d[p * 3]; rgba[p * 4 + 1] = d[p * 3 + 1]; rgba[p * 4 + 2] = d[p * 3 + 2]; rgba[p * 4 + 3] = 255; }
    else if (img.kind === 1) {
      const row = (img.width + 7) >> 3;
      for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) {
        const v = (d[yy * row + (xx >> 3)] >> (7 - (xx & 7))) & 1 ? 255 : 0, p = (yy * img.width + xx) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = v; rgba[p + 3] = 255;
      }
    } else return null;
    x.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
  } else return null;
  // In view space an upright picture has m[0] > 0 and m[3] < 0; otherwise it is mirrored.
  const k = Math.min(1, 2400 / Math.max(c.width, c.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(c.width * k)); out.height = Math.max(1, Math.round(c.height * k));
  const o = out.getContext('2d');
  o.fillStyle = '#fff';
  o.fillRect(0, 0, out.width, out.height);
  o.translate(m[0] < 0 ? out.width : 0, m[3] > 0 ? out.height : 0);
  o.scale(m[0] < 0 ? -k : k, m[3] > 0 ? -k : k);
  o.drawImage(c, 0, 0);
  c.width = c.height = 0;
  const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.85));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

const NONE = (D) => ({ style: D.BorderStyle.NONE, size: 0, color: 'auto' });
const noBorders = (D) => ({ top: NONE(D), bottom: NONE(D), left: NONE(D), right: NONE(D), insideHorizontal: NONE(D), insideVertical: NONE(D) });
const spacer = (D, h) => new D.Paragraph({ spacing: { before: 0, after: 0, line: Math.max(20, h), lineRule: D.LineRuleType.EXACT }, children: [] });

// Blocks as Word paragraphs and tables, between `left` and `right` (points
// on the page), starting at `top`. `shade` is the colour behind them.
function wordBlocks(D, blocks, { left, right, top, shade = null, maxGap = 72 }) {
  const out = [];
  let prev = top;
  for (const b of blocks) {
    const before = tw(clamp(b.top - prev, 0, maxGap));
    prev = Math.max(prev, b.bottom);
    if (b.type === 'image') {
      if (!b.pic) continue;
      const w = b.x1 - b.x0, k = Math.min(1, (right - left) / Math.max(1, w));
      out.push(new D.Paragraph({
        spacing: { before, after: 0 }, indent: { left: tw(clamp(b.x0 - left, 0, Math.max(0, right - left - w * k))) },
        children: [new D.ImageRun({ type: b.pic.type, data: b.pic.bytes, transformation: { width: px(w * k), height: px((b.bottom - b.top) * k) } })],
      }));
    } else if (b.type === 'text') {
      out.push(wordParagraph(D, b, { left, right, before, shade }));
    } else {
      // The gap above a table is an empty paragraph that tall; two tables in a row need one between them too, or Word joins them.
      if (before > 40 || out[out.length - 1] instanceof D.Table) out.push(spacer(D, before));
      out.push(b.type === 'cols' ? colsTable(D, b, left) : b.ruled ? ruledTable(D, b, left) : wordTable(D, b, left, shade));
    }
  }
  // Word needs a paragraph after a table that ends a section or a cell, and every cell needs one.
  if (!out.length || out[out.length - 1] instanceof D.Table) out.push(spacer(D, 20));
  return out;
}

const lum = (c) => { const n = parseInt(c.slice(1), 16); return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) / 255; };

function wordRuns(D, runs, shade = null) {
  const out = [];
  for (let k = 0; k < runs.length;) {
    const link = runs[k].link;
    const group = [];
    while (k < runs.length && runs[k].link === link) group.push(runs[k++]);
    const made = group.map((r) => (r.br ? new D.TextRun({ break: 1 }) : new D.TextRun({
      text: r.text, bold: r.bold, italics: r.italic, size: Math.max(2, Math.round(r.size * 2)), font: r.font,
      // Always set: heading styles would otherwise paint black text blue. White
      // text with nothing behind it in the document would vanish: it goes black.
      color: link && r.color === '#000000' ? '0563C1' : !shade && lum(r.color) > 0.85 ? '000000' : r.color.slice(1),
      underline: link ? {} : undefined,
    })));
    out.push(...(link ? [new D.ExternalHyperlink({ link, children: made })] : made));
  }
  return out;
}

function alignOf(b, left, right) {
  const L = b.lines;
  const mid = (left + right) / 2;
  if (L.every((l) => Math.abs((l.x0 + l.x1) / 2 - mid) < 4) && L[0].x0 > left + 18) return 'center';
  if (L.every((l) => Math.abs(l.x1 - right) < 4) && L[0].x0 > left + 36) return 'right';
  if (L.length >= 3 && L.slice(0, -1).every((l) => Math.abs(l.x1 - b.x1) < 1.5) && L[L.length - 1].x1 < b.x1 - 6 && !L.some((l) => l.br)) return 'both';
  return 'left';
}

function wordParagraph(D, b, { left, right, before, shade = null }) {
  let runs = blockRuns(b.lines, true);
  const L = b.lines;
  const bg = b.shade || shade;
  const opts = { spacing: { before, after: 0 } };
  if (b.shade) opts.shading = { fill: b.shade.slice(1), type: D.ShadingType.CLEAR, color: 'auto' };
  if (L.length > 1) {
    const lead = (L[L.length - 1].y - L[0].y) / (L.length - 1);
    opts.spacing.line = clamp(Math.round((lead / (b.size * 1.15)) * 240), 240, 720);
  }
  const align = alignOf(b, left, right);
  opts.alignment = { center: D.AlignmentType.CENTER, right: D.AlignmentType.RIGHT, both: D.AlignmentType.JUSTIFIED, left: D.AlignmentType.LEFT }[align];
  if (b.level) opts.heading = D.HeadingLevel[`HEADING_${b.level}`];
  const rest = L.length > 1 ? Math.min(...L.slice(1).map((l) => l.x0)) : L[0].x0;
  if (b.list && !b.list.ordered) {
    // A real Word bullet; the marker glyph itself goes.
    runs = dropFront(runs, b.list.marker.length);
    opts.bullet = { level: b.list.level };
  } else if (b.list) {
    // Numbered items keep their own numbers (a list may carry on from the last page), with a hanging indent.
    const textX = L.length > 1 ? rest : L[0].x0 + b.size * 1.5;
    opts.indent = { left: tw(Math.max(0, textX - left)), hanging: tw(Math.max(0, textX - L[0].x0)) };
    runs = runs.map((r, k) => (k === 0 ? { ...r, text: r.text.replace(NUMBERED, (m, n) => `${n}.\t`) } : r));
  } else if (align === 'left' || align === 'both') {
    const ind = rest - left, first = L[0].x0 - rest;
    if (ind > 3 || Math.abs(first) > 3) opts.indent = { left: tw(Math.max(0, ind)), ...(first > 3 ? { firstLine: tw(first) } : first < -3 ? { hanging: tw(-first) } : {}) };
  }
  return new D.Paragraph({ ...opts, children: wordRuns(D, runs, bg) });
}

const numericCols = (t) => t.cols.map((_, k) => {
  const vals = t.cells.slice(1).map((r) => runsText(r[k] || [])).filter(Boolean);
  return vals.length > 0 && vals.every((v) => toNumber(v));
});

// A table of lined-up text, with no lines drawn: no borders either.
function wordTable(D, t, left, shade = null) {
  const widths = t.cols.map((c, k) => {
    const next = t.cols[k + 1];
    return tw((next ? next.x0 - 3 : c.x1 + 9) - (k ? c.x0 - 3 : t.x0 - 3));
  });
  const nums = numericCols(t);
  return new D.Table({
    columnWidths: widths,
    width: { size: widths.reduce((s, w) => s + w, 0), type: D.WidthType.DXA },
    layout: D.TableLayoutType.FIXED,
    indent: { size: tw(Math.max(0, t.x0 - left - 3)), type: D.WidthType.DXA },
    borders: noBorders(D),
    rows: t.cells.map((row) => new D.TableRow({
      children: row.map((runs, k) => new D.TableCell({
        width: { size: widths[k], type: D.WidthType.DXA },
        margins: { top: 0, bottom: 0, left: 60, right: 60 },
        children: [new D.Paragraph({ alignment: nums[k] ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT, children: wordRuns(D, runs, shade) })],
      })),
    })),
  });
}

// A table drawn with lines: the same grid, merged cells, shading and the
// borders that were drawn.
function ruledTable(D, t, left) {
  const widths = t.xs.slice(0, -1).map((x, c) => tw(t.xs[c + 1] - x));
  const sz = clamp(Math.round(t.width * 8), 2, 48); // eighths of a point
  const edge = (on) => (on ? { style: D.BorderStyle.SINGLE, size: sz, color: t.color.slice(1) } : NONE(D));
  const pad = 4;
  const rows = [];
  for (let r = 0; r < t.ys.length - 1; r++) {
    rows.push(new D.TableRow({
      height: { value: tw(t.ys[r + 1] - t.ys[r]), rule: D.HeightRule.ATLEAST },
      children: t.cellList.filter((c) => c.r0 === r).map((c) => new D.TableCell({
        width: { size: widths.slice(c.c0, c.c1 + 1).reduce((s, w) => s + w, 0), type: D.WidthType.DXA },
        columnSpan: c.c1 - c.c0 + 1, rowSpan: c.r1 - c.r0 + 1,
        margins: { top: tw(1), bottom: tw(1), left: tw(pad), right: tw(pad) },
        shading: c.fill ? { fill: c.fill.slice(1), type: D.ShadingType.CLEAR, color: 'auto' } : undefined,
        borders: { top: edge(c.edges.top), bottom: edge(c.edges.bottom), left: edge(c.edges.left), right: edge(c.edges.right) },
        children: wordBlocks(D, c.blocks, { left: c.box[0] + pad, right: c.box[2] - pad, top: c.box[1] + 1, shade: c.fill }),
      })),
    }));
  }
  return new D.Table({
    columnWidths: widths,
    width: { size: widths.reduce((s, w) => s + w, 0), type: D.WidthType.DXA },
    layout: D.TableLayoutType.FIXED,
    indent: { size: tw(Math.max(0, t.x0 - left)), type: D.WidthType.DXA },
    borders: noBorders(D),
    rows,
  });
}

// Pieces side by side (a logo beside an address, columns of text): a table
// without borders, one cell per column.
function colsTable(D, b, left) {
  const widths = b.cols.map((c) => tw(c.x1 - c.x0));
  return new D.Table({
    columnWidths: widths,
    width: { size: widths.reduce((s, w) => s + w, 0), type: D.WidthType.DXA },
    layout: D.TableLayoutType.FIXED,
    indent: { size: tw(Math.max(0, b.x0 - left)), type: D.WidthType.DXA },
    borders: noBorders(D),
    rows: [new D.TableRow({
      children: b.cols.map((c, k) => new D.TableCell({
        width: { size: widths[k], type: D.WidthType.DXA },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        children: wordBlocks(D, c.blocks, { left: c.x0, right: c.x1, top: b.top, maxGap: 600 }),
      })),
    })],
  });
}

/* ---------- PDF -> POWERPOINT ---------- */

const pdfToPpt = {
  id: 'pdf-to-ppt', keywords: 'pptx powerpoint slides presentation deck convert office', title: 'PDF to PowerPoint', icon: 'toPpt', color: '#ea580c', cat: 'convert',
  action: 'Convert to PowerPoint', busyText: 'Converting…',
  desc: 'Turn each page into a PowerPoint slide.',
  long: 'Each page becomes a slide, drawn sharp from the PDF. With editable text on, the words become text boxes you can change and a picture keeps the rest.',
  setup(ctx) {
    ctx.state = { text: true };
    ctx.main.append(fileHero(ctx.items[0]));
    ctx.side.append(
      check('Add editable text boxes', true, (v) => (ctx.state.text = v)),
      h('p', {}, 'Text boxes use the closest font your computer has, so lines can run a little longer or shorter than in the PDF. Drawings and photos stay part of the slide picture.'));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    await loadScript('vendor/pptxgenjs/pptxgen.min.js');
    const pptx = new window.PptxGenJS();
    const first = (await doc.js.getPage(1)).getViewport({ scale: 1 });
    // Inches per point, shrunk if the page is past PowerPoint's 56-inch limit.
    const k = Math.min(1 / 72, 56 / Math.max(first.width, first.height));
    const SW = first.width * k, SH = first.height * k;
    pptx.defineLayout({ name: 'PDF', width: SW, height: SH });
    pptx.layout = 'PDF';
    pptx.title = baseName(doc.name);

    // With text boxes, the picture behind them is drawn from a copy without that text.
    const lines = [];
    let bare = null;
    if (ctx.state.text) {
      const lib = await loadLib(doc).catch(() => null);
      for (let i = 0; i < doc.pages; i++) {
        busy(`Reading page ${i + 1} of ${doc.pages}…`);
        await tick();
        const pg = await readPdfPage(doc, i, lib);
        // Only text whose drawing commands we found can move to a box; the rest stays in the picture.
        const keep = pg.read ? pg.items.filter((it) => !it.hidden && it.ops.length) : [];
        if (keep.length) {
          const drop = new Set(keep.flatMap((it) => it.ops));
          for (const it of pg.items) if (!keep.includes(it) && it.ops.some((op) => drop.has(op))) keep.push(it);
          try { dropOps(lib, pg.read, drop); } catch (err) { console.warn(err); keep.length = 0; }
        }
        lines.push(toLines(keep));
      }
      if (lib) bare = await window.pdfjsLib.getDocument({ data: await lib.save(), isEvalSupported: false }).promise;
    }
    for (let i = 0; i < doc.pages; i++) {
      busy(`Slide ${i + 1} of ${doc.pages}…`);
      await tick();
      const vp = (await doc.js.getPage(i + 1)).getViewport({ scale: 1 });
      const fit = Math.min(SW / (vp.width * k), SH / (vp.height * k));
      const u = k * fit; // inches per PDF point on this slide
      const w = vp.width * u, hh = vp.height * u;
      const ox = (SW - w) / 2, oy = (SH - hh) / 2;
      const jpg = await pageJpeg(bare || doc.js, i, clamp(2400 / Math.max(vp.width, vp.height), 1, 4));
      const slide = pptx.addSlide();
      // PptxGenJS takes the file type from `path` (it doesn't fetch it when there is data).
      const pic = { data: 'image/jpeg;base64,' + b64(jpg), path: `page-${i + 1}.jpg` };
      if (Math.abs(w - SW) < 0.01 && Math.abs(hh - SH) < 0.01) slide.background = pic;
      else slide.addImage({ ...pic, x: ox, y: oy, w, h: hh });
      for (const l of lines[i] || []) for (const sg of l.segs) {
        slide.addText(sg.runs.map((r) => ({
          text: r.text,
          options: { bold: r.bold, italic: r.italic, color: r.color.slice(1), fontFace: r.font, fontSize: +(r.size * u * 72).toFixed(1), ...(r.link ? { hyperlink: { url: r.link } } : {}) },
        })), {
          x: ox + sg.x0 * u, y: oy + (l.y - l.size * 0.95) * u, w: (sg.x1 - sg.x0) * u * 1.06 + 0.05, h: l.size * 1.25 * u,
          margin: 0, valign: 'top', wrap: false,
        });
      }
    }
    bare?.destroy();
    busy('Saving…');
    await tick();
    const bytes = await pptx.write({ outputType: 'uint8array' });
    return {
      files: [{ name: `${baseName(doc.name)}.pptx`, bytes, type: MIME.pptx }],
      title: 'Your presentation is ready',
      note: `${doc.pages} slide${doc.pages === 1 ? '' : 's'}${ctx.state.text ? ', with editable text.' : ', each a picture of its page.'}`,
    };
  },
};

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ---------- PDF -> EXCEL ---------- */

const pdfToExcel = {
  id: 'pdf-to-excel', keywords: 'xlsx xls excel spreadsheet table sheet convert office', title: 'PDF to Excel', icon: 'toExcel', color: '#16a34a', cat: 'convert',
  action: 'Convert to Excel', busyText: 'Converting…',
  desc: 'Pull tables out of a PDF into a spreadsheet.',
  long: 'Finds tables by how the text lines up in columns and puts them in an .xlsx, with numbers as real numbers. Works on PDFs with real text, not on scans.',
  setup(ctx) {
    const s = ctx.state = { what: 'tables', one: false };
    ctx.main.append(fileHero(ctx.items[0]));
    ctx.side.append(
      field('What to take', segmented([['tables', 'Tables only'], ['all', 'All text']], s.what, (v) => (s.what = v))),
      check('All pages in one sheet', false, (v) => (s.one = v)),
      h('p', {}, 'Amounts like 1,234.56, (120) and 15% become numbers you can add up. A cell that wraps onto two lines comes out as two rows.'));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state;
    const { pages } = await readDoc(doc, readingProgress);
    if (!pages.some((pg) => pg.items.length)) throw new Error('This PDF has no text, it looks like a scan. Run OCR on it first.');
    busy('Building the spreadsheet…');
    await loadScript('vendor/sheetjs/xlsx.full.min.js');
    const X = window.XLSX;
    const sheets = pages.map((pg) => sheetRows(pg, s.what));
    if (!sheets.some((rows) => rows.length)) throw new Error('No tables found. Pick “All text” to get every line.');
    const wb = X.utils.book_new();
    if (s.one) X.utils.book_append_sheet(wb, makeSheet(X, sheets.filter((r) => r.length).flatMap((rows) => [...rows, []]).slice(0, -1)), 'PDF');
    else sheets.forEach((rows, i) => rows.length && X.utils.book_append_sheet(wb, makeSheet(X, rows), `Page ${i + 1}`));
    const tables = pages.reduce((n, pg) => n + pg.blocks.filter((b) => b.type === 'table').length, 0);
    const bytes = new Uint8Array(X.write(wb, { bookType: 'xlsx', type: 'array', compression: true }));
    const sheetsN = wb.SheetNames.length;
    return {
      files: [{ name: `${baseName(doc.name)}.xlsx`, bytes, type: MIME.xlsx }],
      title: 'Your spreadsheet is ready',
      note: `${tables} table${tables === 1 ? '' : 's'} found · ${sheetsN} sheet${sheetsN === 1 ? '' : 's'}`,
    };
  },
};

// Rows of cell texts for one page. Tables keep their columns; with all text,
// other lines put each segment in its own column. A blank row sets tables apart.
function sheetRows(pg, what) {
  const rows = [];
  for (const b of pg.blocks) {
    if (b.type === 'table') {
      if (rows.length) rows.push([]);
      rows.push(...b.cells.map((r) => r.map(runsText)));
      if (what === 'all') rows.push([]);
    } else if (b.type === 'text' && what === 'all') {
      for (const l of b.lines) rows.push(l.segs.map(segText));
    }
  }
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows;
}

function makeSheet(X, rows) {
  const ws = {};
  const widths = [];
  rows.forEach((row, r) => row.forEach((text, c) => {
    if (!text) return;
    const n = toNumber(text);
    ws[X.utils.encode_cell({ r, c })] = n ? { t: 'n', v: n.v, ...(n.z ? { z: n.z } : {}) } : { t: 's', v: text };
    widths[c] = Math.max(widths[c] || 8, Math.min(60, text.length + 2));
  }));
  const cols = Math.max(1, ...rows.map((r) => r.length));
  ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: cols - 1 } });
  ws['!cols'] = Array.from({ length: cols }, (_, c) => ({ wch: widths[c] || 8 }));
  return ws;
}

/* ---------- PDF -> MARKDOWN ---------- */

const pdfToMarkdown = {
  id: 'pdf-to-markdown', keywords: 'md markdown text github readme convert export', title: 'PDF to Markdown', icon: 'toMd', color: '#1e293b', cat: 'convert',
  action: 'Download Markdown', busyText: 'Converting…', wide: true,
  desc: 'Turn a PDF into clean Markdown text.',
  long: 'Headings, lists, bold and italic, links and tables as Markdown. Check the preview, then download the .md file.',
  setup(ctx) {
    const doc = ctx.items[0];
    const s = ctx.state = { view: 'rendered', breaks: false, md: '' };
    const wait = h('p', { class: 'fp-md__wait' }, 'Reading the PDF…');
    const out = h('div', { class: 'fp-md__out' }, wait);
    const stats = h('span', { class: 'fp-md__stats' });
    const copy = h('button', {
      class: 'linkbtn', type: 'button', disabled: true,
      onclick: async () => {
        try { await navigator.clipboard.writeText(s.md); toast('Markdown copied.'); } catch { toast('Could not copy. Download the file instead.', 'bad'); }
      },
    }, icon('copy'), 'Copy');
    const draw = () => {
      if (!s.pages) return;
      const blocks = mdBlocks(s.pages, s.breaks);
      s.md = toMarkdown(blocks);
      const words = s.md.split(/\s+/).filter((w) => /\w/.test(w)).length;
      stats.textContent = `${words.toLocaleString()} words`;
      out.replaceChildren(s.view === 'raw' ? h('pre', { class: 'fp-md__raw' }, s.md) : h('div', { class: 'fp-md__doc' }, mdDom(blocks)));
    };
    ctx.main.append(h('div', { class: 'fp-md' },
      h('div', { class: 'fp-md__bar' },
        segmented([['rendered', 'Preview'], ['raw', 'Markdown']], s.view, (v) => { s.view = v; draw(); }),
        h('div', { class: 'fp-md__tools' }, stats, copy)),
      out));
    ctx.side.append(fileRow(doc),
      check('Mark page breaks with a line', false, (v) => { s.breaks = v; draw(); }),
      h('p', {}, 'Headings come from text size, lists from • and 1. markers, tables from text that lines up in columns. Pictures are left out.'));
    ctx.action.disabled = true;
    s.ready = readDoc(doc, (i, n) => { wait.textContent = `Reading page ${i + 1} of ${n}…`; }).then(({ pages }) => {
      if (!pages.some((pg) => pg.items.length)) {
        wait.textContent = 'This PDF has no text, it looks like a scan. Run OCR on it first.';
        return;
      }
      s.pages = pages;
      draw();
      ctx.action.disabled = false;
      copy.disabled = false;
    }, (err) => { console.error(err); wait.textContent = 'Could not read the text in this PDF.'; });
  },
  async run(ctx) {
    const doc = ctx.items[0];
    await ctx.state.ready;
    return {
      files: [{ name: `${baseName(doc.name)}.md`, bytes: new Blob([ctx.state.md], { type: 'text/markdown' }), type: 'text/markdown' }],
      title: 'Your Markdown is ready',
    };
  },
};

// The document as Markdown blocks, shared by the file and the preview.
function mdBlocks(pages, breaks) {
  const out = [];
  pages.forEach((pg, i) => {
    if (breaks && i) out.push({ kind: 'hr' });
    const firstText = pg.blocks.find((x) => x.type === 'text');
    for (const b of pg.blocks) {
      if (b.type === 'table') out.push({ kind: 'table', rows: b.cells, right: numericCols(b) });
      if (b.type !== 'text') continue;
      const runs = blockRuns(b.lines);
      if (!runs.length) continue;
      const prev = out[out.length - 1];
      // A sentence cut by a page break carries on.
      if (!breaks && b === firstText && !b.level && !b.list && prev?.kind === 'p' && prev.page === i - 1
        && !/[.!?:]["”’)]?$/.test(runsText(prev.runs)) && /^\p{Ll}/u.test(runsText(runs))) {
        prev.runs = mergeRuns([...prev.runs, { ...runs[0], text: ' ' }, ...runs]);
        prev.page = i;
      } else if (b.level) out.push({ kind: 'h', level: b.level, text: runsText(runs) });
      else if (b.list) out.push({ kind: 'li', ordered: b.list.ordered, num: b.list.ordered ? b.list.marker.match(/\d+/)[0] : null, level: b.list.level, runs: dropFront(runs, b.list.marker.length) });
      else out.push({ kind: 'p', runs, page: i });
    }
  });
  return out;
}

const mdEsc = (t) => t.replace(/([\\`*_~[\]<>|])/g, '\\$1');

// Groups of runs that share a link, in order. A space at the end of a link
// goes outside it, so it isn't underlined.
function byLink(runs) {
  const groups = [];
  for (const r of runs) {
    const g = groups[groups.length - 1];
    if (g && g.link === r.link) g.runs.push(r);
    else groups.push({ link: r.link, runs: [r] });
  }
  return groups.flatMap((g) => {
    const last = g.runs[g.runs.length - 1];
    if (!g.link || !/\s$/.test(last.text)) return [g];
    g.runs[g.runs.length - 1] = { ...last, text: last.text.trimEnd() };
    return [g, { link: null, runs: [{ ...last, link: null, text: ' ' }] }];
  });
}

function mdInline(runs) {
  return byLink(runs).map(({ link, runs: rs }) => {
    // Bold or italic around a run, with its outer spaces kept outside the markers.
    const inner = rs.map((r) => {
      const [, lead, core, trail] = r.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const mark = !core ? '' : r.bold && r.italic ? '***' : r.bold ? '**' : r.italic ? '*' : '';
      return lead + mark + mdEsc(core) + mark + trail;
    }).join('');
    if (!link) return inner;
    const [, lead, text, trail] = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    // encodeURIComponent leaves ( and ) alone, and a ) would end the link early.
    return `${lead}[${text}](${link.replace(/[()\s<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))})${trail}`;
  }).join('');
}

function toMarkdown(blocks) {
  const parts = blocks.map((b, k) => {
    const tight = b.kind === 'li' && blocks[k - 1]?.kind === 'li' && blocks[k - 1].ordered === b.ordered;
    let text;
    if (b.kind === 'hr') text = '---';
    else if (b.kind === 'h') text = `${'#'.repeat(b.level)} ${mdEsc(b.text)}`;
    else if (b.kind === 'li') text = `${'   '.repeat(b.level)}${b.ordered ? b.num + '.' : '-'} ${mdInline(b.runs)}`;
    else if (b.kind === 'table') {
      const row = (r) => `| ${r.map((c) => mdInline(c) || ' ').join(' | ')} |`;
      // Header cells are bold already.
      text = [row(b.rows[0].map((c) => c.map((r) => ({ ...r, bold: false })))), `| ${b.right.map((r) => (r ? '---:' : '---')).join(' | ')} |`, ...b.rows.slice(1).map(row)].join('\n');
    } else {
      // A paragraph that starts like a heading, list item, rule (---) or setext
      // underline (===) must not turn into one.
      text = mdInline(b.runs).replace(/^(#{1,6}\s|[-+=])/, '\\$1').replace(/^(\d+)([.)]\s)/, '$1\\$2');
    }
    return (k && !tight ? '\n' : '') + text;
  });
  return parts.join('\n') + '\n';
}

// The same blocks as HTML for the preview, built as DOM nodes (never as HTML text).
function mdDom(blocks) {
  const inline = (runs) => byLink(runs).map(({ link, runs: rs }) => {
    const nodes = rs.map((r) => {
      let n = r.text;
      if (r.italic) n = h('em', {}, n);
      if (r.bold) n = h('strong', {}, n);
      return n;
    });
    return link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, nodes) : nodes;
  }).flat();
  const out = [];
  let list = null;
  for (const b of blocks) {
    if (b.kind !== 'li') list = null;
    if (b.kind === 'hr') out.push(h('hr'));
    else if (b.kind === 'h') out.push(h(`h${b.level}`, {}, b.text));
    else if (b.kind === 'p') out.push(h('p', {}, inline(b.runs)));
    else if (b.kind === 'li') {
      if (list?.ordered !== b.ordered) { list = { ordered: b.ordered, el: h(b.ordered ? 'ol' : 'ul') }; out.push(list.el); }
      list.el.append(h('li', { value: b.num, style: { marginLeft: b.level * 22 + 'px' } }, inline(b.runs)));
    } else if (b.kind === 'table') {
      const cell = (tag) => (c, k) => h(tag, { class: b.right[k] ? 'num' : null }, inline(c));
      out.push(h('div', { class: 'fp-md__table' }, h('table', {},
        h('thead', {}, h('tr', {}, b.rows[0].map(cell('th')))),
        h('tbody', {}, b.rows.slice(1).map((r) => h('tr', {}, r.map(cell('td'))))))));
    }
  }
  return out;
}

/* ---------- PDF -> PDF/A ---------- */

const pdfToPdfa = {
  id: 'pdf-to-pdfa', keywords: 'pdfa pdf/a archive archival iso 19005 long term preserve', title: 'PDF to PDF/A', icon: 'toPdfa', color: '#64748b', cat: 'convert',
  action: 'Convert to PDF/A', busyText: 'Converting…',
  desc: 'Make an archive copy (PDF/A-2b) for long-term keeping.',
  long: 'Makes a PDF/A-2b copy: adds the archive metadata and an sRGB color profile, and removes passwords, JavaScript and attached files. Pages with fonts that aren’t embedded, print (CMYK) colors or form fields become images so the file stays valid. These are the rules we check, not every rule in the standard: use a validator such as veraPDF if it must pass an audit.',
  setup(ctx) {
    ctx.state = { all: false };
    ctx.main.append(fileHero(ctx.items[0]));
    ctx.side.append(
      choiceCards([
        [false, 'Keep text where possible', 'Only pages that can’t be archived as they are become images'],
        [true, 'All pages as images', 'Looks exactly like the original, text is not selectable'],
      ], false, (v) => (ctx.state.all = v)),
      h('p', {}, 'Pages that become images lose selectable text and form fields. Links stay.'));
  },
  async run(ctx) {
    const doc = ctx.items[0];
    const lib = await loadLib(doc);
    busy('Checking fonts and colors…');
    await tick();
    const removed = stripForbidden(lib);
    const pages = lib.getPages();
    const why = pages.map((p) => (ctx.state.all ? 'all' : pageProblem(lib, p)));
    const raster = why.map((w, i) => (w ? i : -1)).filter((i) => i >= 0);
    for (const [k, i] of raster.entries()) {
      busy(`Page ${i + 1} to an image (${k + 1} of ${raster.length})…`);
      await tick();
      await pageToImage(lib, pages[i], doc.js, i);
    }
    busy('Saving…');
    await tick();
    await writePdfa(lib);
    const bytes = await lib.save({ useObjectStreams: false, updateFieldAppearances: false });
    const nums = raster.map((i) => i + 1);
    const REASON = { font: 'fonts that aren’t embedded', cmyk: 'print (CMYK) colors', annot: 'form fields or notes PDF/A can’t keep' };
    const reasons = [...new Set(why.filter((w) => REASON[w]))].map((w) => REASON[w]);
    const notes = [];
    if (ctx.state.all) notes.push('Every page is now an image.');
    else if (nums.length) notes.push(`${pageList(nums)} had ${reasons.join(' or ')}, so ${nums.length === 1 ? 'it is now an image' : 'they are now images'}.`);
    else notes.push('All fonts were embedded already, so every page keeps its text.');
    if (removed.length) notes.push(`Removed: ${removed.join(', ')}.`);
    return { files: [pdfOut(`${baseName(doc.name)}-pdfa.pdf`, bytes)], title: 'Your PDF/A is ready', note: notes.join(' ') };
  },
};

const PL = window.PDFLib;
const N = (n) => PL.PDFName.of(n);
// Actions PDF/A-2 forbids.
const BAD_ACTION = /^\/(JavaScript|Launch|Sound|Movie|ResetForm|ImportData|Hide|SetOCGState|Rendition|Trans|GoTo3DView|GoToE)$/;

// Calls fn(dict, object) for every dictionary in the file, nested ones too.
function eachDict(ctx, fn) {
  const seen = new Set();
  const visit = (o) => {
    const d = o instanceof PL.PDFDict ? o : o instanceof PL.PDFStream ? o.dict : null;
    if (d) {
      if (seen.has(d)) return;
      seen.add(d);
      fn(d, o);
      for (const [, v] of d.entries()) visit(v);
    } else if (o instanceof PL.PDFArray) o.asArray().forEach(visit);
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj);
}

// Takes out scripts, attachments and other things PDF/A doesn't allow, and
// says what went.
function stripForbidden(lib) {
  const ctx = lib.context;
  const cat = lib.catalog;
  const found = new Set();
  const names = cat.lookup(N('Names'));
  if (names instanceof PL.PDFDict) {
    if (names.has(N('JavaScript'))) { names.delete(N('JavaScript')); found.add('JavaScript'); }
    if (names.has(N('EmbeddedFiles'))) { names.delete(N('EmbeddedFiles')); found.add('attached files'); }
  }
  ['Collection', 'Version', 'Requirements'].forEach((k) => cat.delete(N(k)));
  const form = cat.lookup(N('AcroForm'));
  eachDict(ctx, (d) => {
    if (d.has(N('AA'))) { d.delete(N('AA')); found.add('JavaScript'); }
    for (const key of ['A', 'OpenAction', 'Next']) {
      const a = d.lookup(N(key));
      if (a instanceof PL.PDFDict && BAD_ACTION.test(String(a.get(N('S'))))) {
        found.add(String(a.get(N('S'))) === '/JavaScript' ? 'JavaScript' : 'actions');
        d.delete(N(key));
      }
    }
    const sub = String(d.get(N('Subtype')));
    if (sub === '/Image') { d.delete(N('Alternates')); d.delete(N('OPI')); if (d.has(N('Interpolate'))) d.set(N('Interpolate'), PL.PDFBool.False); }
    if (sub === '/Form') d.delete(N('OPI'));
    if (String(d.get(N('Type'))) === '/ExtGState') { d.delete(N('TR')); if (d.has(N('TR2'))) d.set(N('TR2'), N('Default')); }
    if (d === form) { d.delete(N('XFA')); d.delete(N('NeedAppearances')); }
  });
  // Optional content settings need a name and no automatic state changes.
  const oc = cat.lookup(N('OCProperties'));
  if (oc instanceof PL.PDFDict) {
    const configs = [oc.lookup(N('D')), ...(oc.lookup(N('Configs'))?.asArray?.() || []).map((r) => ctx.lookup(r))];
    configs.forEach((c, k) => { if (c instanceof PL.PDFDict) { if (!c.has(N('Name'))) c.set(N('Name'), PL.PDFString.of(k ? `View ${k}` : 'Default')); c.delete(N('AS')); } });
  }
  for (const page of lib.getPages()) {
    const annots = page.node.lookup(N('Annots'));
    if (!(annots instanceof PL.PDFArray)) continue;
    const keep = annots.asArray().filter((r) => {
      const a = ctx.lookup(r);
      if (!(a instanceof PL.PDFDict)) return false;
      const sub = String(a.get(N('Subtype')));
      if (/^\/(FileAttachment|Sound|Movie|Screen|3D|RichMedia)$/.test(sub)) { found.add(sub === '/FileAttachment' ? 'attached files' : 'media'); return false; }
      // Annotations must print and can't be hidden.
      const f = a.lookup(N('F'))?.asNumber?.() || 0;
      a.set(N('F'), PL.PDFNumber.of((f | 4) & ~(1 | 2 | 32 | 256)));
      return true;
    });
    page.node.set(N('Annots'), ctx.obj(keep));
  }
  return [...found];
}

const decode = (s) => (s instanceof PL.PDFRawStream ? PL.decodePDFRawStream(s).decode() : s.getUnencodedContents?.() || s.getContents?.() || new Uint8Array());
const usesCmyk = (bytes) => /\/(DeviceCMYK|CMYK)\b|(^|\s)[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[kK](?=\s|$)/.test(new TextDecoder('latin1').decode(bytes));

function fontEmbedded(font) {
  const sub = String(font.get(N('Subtype')));
  if (sub === '/Type3') return true; // its glyphs are drawings in the file
  const f = sub === '/Type0' ? font.lookup(N('DescendantFonts'))?.lookup?.(0) : font;
  const desc = f instanceof PL.PDFDict ? f.lookup(N('FontDescriptor')) : null;
  return desc instanceof PL.PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => desc.has(N(k)));
}

// Why a page can't stay as it is in a PDF/A-2b with an sRGB profile, or null.
function pageProblem(lib, page) {
  const ctx = lib.context;
  const seen = new Set();
  let why = null;
  const content = (s) => { try { if (usesCmyk(decode(s))) why ||= 'cmyk'; } catch { /* a stream we can't read is left alone */ } };
  const res = (R) => {
    R = ctx.lookup(R);
    if (!(R instanceof PL.PDFDict) || seen.has(R)) return;
    seen.add(R);
    const fonts = R.lookup(N('Font'));
    if (fonts instanceof PL.PDFDict) for (const [, f] of fonts.entries()) { const fd = ctx.lookup(f); if (fd instanceof PL.PDFDict && !fontEmbedded(fd)) why = 'font'; }
    const cs = R.lookup(N('ColorSpace'));
    if (cs instanceof PL.PDFDict) for (const [, c] of cs.entries()) if (/DeviceCMYK/.test(String(ctx.lookup(c)))) why ||= 'cmyk';
    // Shadings and patterns carry their own colour spaces.
    const cmykShading = (ref) => {
      const sh = ctx.lookup(ref);
      const d = sh instanceof PL.PDFStream ? sh.dict : sh;
      if (d instanceof PL.PDFDict && /DeviceCMYK/.test(String(d.lookup(N('ColorSpace'))))) why ||= 'cmyk';
    };
    const shadings = R.lookup(N('Shading'));
    if (shadings instanceof PL.PDFDict) for (const [, sh] of shadings.entries()) cmykShading(sh);
    const patterns = R.lookup(N('Pattern'));
    if (patterns instanceof PL.PDFDict) for (const [, ref] of patterns.entries()) {
      const pat = ctx.lookup(ref);
      const d = pat instanceof PL.PDFStream ? pat.dict : pat;
      if (!(d instanceof PL.PDFDict)) continue;
      if (d.has(N('Shading'))) cmykShading(d.get(N('Shading')));
      if (pat instanceof PL.PDFStream) { content(pat); res(d.get(N('Resources'))); }
    }
    const xo = R.lookup(N('XObject'));
    if (xo instanceof PL.PDFDict) for (const [, ref] of xo.entries()) {
      const x = ctx.lookup(ref);
      if (!(x instanceof PL.PDFStream)) continue;
      const sub = String(x.dict.get(N('Subtype')));
      if (sub === '/Image' && /DeviceCMYK/.test(String(x.dict.lookup(N('ColorSpace'))))) why ||= 'cmyk';
      if (sub === '/Form') { content(x); res(x.dict.get(N('Resources'))); }
    }
  };
  res(page.node.Resources());
  const c = page.node.Contents();
  (c instanceof PL.PDFArray ? c.asArray().map((r) => ctx.lookup(r)) : c ? [c] : []).forEach(content);
  const annots = page.node.lookup(N('Annots'));
  if (annots instanceof PL.PDFArray) for (const r of annots.asArray()) {
    const a = ctx.lookup(r);
    if (!(a instanceof PL.PDFDict)) continue;
    const sub = String(a.get(N('Subtype')));
    const rect = a.lookup(N('Rect'))?.asArray?.().map((v) => v.asNumber?.() ?? 0) || [0, 0, 0, 0];
    const ap = a.lookup(N('AP'));
    let normal = ap instanceof PL.PDFDict ? ap.lookup(N('N')) : null;
    // Everything but links and popups needs a drawn appearance, and form fields always.
    if ((!['/Link', '/Popup'].includes(sub) && rect[0] !== rect[2] && rect[1] !== rect[3] && !normal) || (sub === '/Widget' && !ap)) why ||= 'annot';
    if (normal instanceof PL.PDFDict) normal = normal.entries().map(([, v]) => ctx.lookup(v));
    for (const s of [normal].flat()) if (s instanceof PL.PDFStream) { content(s); res(s.dict.get(N('Resources'))); }
  }
  return why;
}

// Swaps a page's content for a 200 dpi picture of it. The page object stays,
// so bookmarks and links to it keep working.
async function pageToImage(lib, page, js, i) {
  const ctx = lib.context;
  const vp = (await js.getPage(i + 1)).getViewport({ scale: 1 });
  const jpg = await lib.embedJpg(await pageJpeg(js, i, 200 / 72, 0.9));
  const node = page.node;
  ['Contents', 'BleedBox', 'TrimBox', 'ArtBox', 'Group', 'Thumb'].forEach((k) => node.delete(N(k)));
  node.set(N('Resources'), ctx.obj({}));
  page.setRotation(degrees(0));
  page.setMediaBox(0, 0, vp.width, vp.height);
  page.setCropBox(0, 0, vp.width, vp.height);
  page.drawImage(jpg, { x: 0, y: 0, width: vp.width, height: vp.height });
  // The picture already shows the form fields and notes; keep only the links.
  const annots = node.lookup(N('Annots'));
  if (!(annots instanceof PL.PDFArray)) return;
  const gone = new Set();
  const keep = annots.asArray().filter((r) => {
    const link = String(ctx.lookup(r)?.get?.(N('Subtype'))) === '/Link';
    if (!link) gone.add(String(r));
    return link;
  });
  // The new page is the old one as seen (rotation and box origin applied), so
  // each link's rectangle moves the same way.
  for (const r of keep) {
    const a = ctx.lookup(r);
    const rect = a?.lookup?.(N('Rect'))?.asArray?.().map((v) => v.asNumber?.() ?? 0);
    if (!rect || rect.length !== 4) continue;
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(rect);
    a.set(N('Rect'), ctx.obj([Math.min(x1, x2), vp.height - Math.max(y1, y2), Math.max(x1, x2), vp.height - Math.min(y1, y2)]));
    a.delete(N('QuadPoints'));
  }
  node.set(N('Annots'), ctx.obj(keep));
  const form = lib.catalog.lookup(N('AcroForm'));
  const fields = form instanceof PL.PDFDict ? form.lookup(N('Fields')) : null;
  if (fields instanceof PL.PDFArray) form.set(N('Fields'), ctx.obj(fields.asArray().filter((r) => !gone.has(String(r)))));
}

// Metadata, color profile, file ID and version that PDF/A-2b asks for.
async function writePdfa(lib) {
  const ctx = lib.context;
  const cat = lib.catalog;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  // Real files often have Info dates or strings pdf-lib can't parse; skip those.
  const safe = (get) => { try { return get(); } catch { return undefined; } };
  const created = safe(() => lib.getCreationDate());
  const meta = {
    title: safe(() => lib.getTitle()), author: safe(() => lib.getAuthor()), subject: safe(() => lib.getSubject()), keywords: safe(() => lib.getKeywords()),
    creator: safe(() => lib.getCreator()) || 'PDF Tools', producer: 'PDF Tools', created: created && !isNaN(created) ? created : now, modified: now,
  };
  // The Info dictionary and the XMP must say the same thing.
  if (meta.title) lib.setTitle(meta.title);
  if (meta.author) lib.setAuthor(meta.author);
  if (meta.subject) lib.setSubject(meta.subject);
  if (meta.keywords) lib.setKeywords([meta.keywords]);
  lib.setCreator(meta.creator);
  lib.setProducer(meta.producer);
  lib.setCreationDate(meta.created);
  lib.setModificationDate(meta.modified);
  lib.getInfoDict().delete(N('Trapped'));
  cat.set(N('Metadata'), ctx.register(ctx.stream(new TextEncoder().encode(xmp(meta)), { Type: 'Metadata', Subtype: 'XML' })));

  const name = PL.PDFString.of('sRGB IEC61966-2.1');
  cat.set(N('OutputIntents'), ctx.obj([ctx.register(ctx.obj({
    Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: name, Info: name,
    RegistryName: PL.PDFString.of('http://www.color.org'), DestOutputProfile: ctx.register(ctx.flateStream(srgbProfile(), { N: 3 })),
  }))]));

  const id = PL.PDFHexString.of([...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
  ctx.trailerInfo.ID = ctx.obj([id, id]);
  ctx.trailerInfo.Encrypt = undefined;
  ctx.header = PL.PDFHeader.forVersion(1, 7);
  await lib.flush();
  dropUnreachable(ctx);
}

// Objects nothing points to any more (a replaced page's fonts, removed
// scripts) would still be written; leave them out.
function dropUnreachable(ctx) {
  const keep = new Set();
  const todo = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
  while (todo.length) {
    const o = todo.pop();
    if (o instanceof PL.PDFRef) {
      if (keep.has(String(o))) continue;
      keep.add(String(o));
      todo.push(ctx.lookup(o));
    } else if (o instanceof PL.PDFDict) todo.push(...o.entries().map((e) => e[1]));
    else if (o instanceof PL.PDFArray) todo.push(...o.asArray());
    else if (o instanceof PL.PDFStream) todo.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!keep.has(String(ref))) ctx.delete(ref);
}

function xmp(m) {
  // eslint-disable-next-line no-control-regex
  const x = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const alt = (v) => `<rdf:Alt><rdf:li xml:lang="x-default">${x(v)}</rdf:li></rdf:Alt>`;
  const opt = [
    m.title && `<dc:title>${alt(m.title)}</dc:title>`,
    m.author && `<dc:creator><rdf:Seq><rdf:li>${x(m.author)}</rdf:li></rdf:Seq></dc:creator>`,
    m.subject && `<dc:description>${alt(m.subject)}</dc:description>`,
    m.keywords && `<pdf:Keywords>${x(m.keywords)}</pdf:Keywords>`,
  ].filter(Boolean).map((l) => `   ${l}\n`).join('');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
${opt}   <pdf:Producer>${x(m.producer)}</pdf:Producer>
   <xmp:CreatorTool>${x(m.creator)}</xmp:CreatorTool>
   <xmp:CreateDate>${iso(m.created)}</xmp:CreateDate>
   <xmp:ModifyDate>${iso(m.modified)}</xmp:ModifyDate>
   <xmp:MetadataDate>${iso(m.modified)}</xmp:MetadataDate>
   <xmpMM:DocumentID>uuid:${crypto.randomUUID()}</xmpMM:DocumentID>
   <xmpMM:InstanceID>uuid:${crypto.randomUUID()}</xmpMM:InstanceID>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// A small ICC v2 sRGB display profile, built here instead of shipped: sRGB
// primaries adapted to D50 (Bradford), D65 media white as in the classic
// HP/Microsoft profile, and the sRGB tone curve sampled at 1024 points.
function srgbProfile() {
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const s15 = (v) => u32(Math.round(v * 65536) >>> 0);
  const sig = (s) => [...s].map((c) => c.charCodeAt(0));
  const zeros = (n) => new Array(n).fill(0);
  const xyz = (...v) => [...sig('XYZ '), ...zeros(4), ...v.flatMap(s15)];
  const desc = (s) => [...sig('desc'), ...zeros(4), ...u32(s.length + 1), ...sig(s), 0, ...zeros(8), ...zeros(3), ...zeros(67)];
  const text = (s) => [...sig('text'), ...zeros(4), ...sig(s), 0];
  const curve = [...sig('curv'), ...zeros(4), ...u32(1024)];
  for (let i = 0; i < 1024; i++) {
    const c = i / 1023;
    const v = Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 65535);
    curve.push(v >> 8, v & 255);
  }
  const tags = [
    ['desc', desc('sRGB IEC61966-2.1')], ['cprt', text('No copyright, use freely')],
    ['wtpt', xyz(0.9505, 1, 1.089)], ['rXYZ', xyz(0.4360747, 0.2225045, 0.0139322)],
    ['gXYZ', xyz(0.3850649, 0.7168786, 0.0971045)], ['bXYZ', xyz(0.1430804, 0.0606169, 0.7141733)],
    ['rTRC', curve], ['gTRC', curve], ['bTRC', curve],
  ];
  const table = [];
  const data = [];
  const placed = new Map(); // the three curves share one copy
  let at = 128 + 4 + tags.length * 12;
  for (const [name, body] of tags) {
    if (!placed.has(body)) {
      placed.set(body, at);
      const padded = body.concat(zeros((4 - (body.length % 4)) % 4));
      data.push(...padded);
      at += padded.length;
    }
    table.push(...sig(name), ...u32(placed.get(body)), ...u32(body.length));
  }
  const header = [
    ...u32(at), ...zeros(4), 0x02, 0x10, 0, 0, ...sig('mntr'), ...sig('RGB '), ...sig('XYZ '),
    0x07, 0xe6, 0, 1, 0, 1, ...zeros(6), // created 2022-01-01
    ...sig('acsp'), ...zeros(28), // platform, flags, maker, model, attributes, intent
    ...s15(0.9642), ...s15(1), ...s15(0.8249), // PCS illuminant D50
    ...zeros(48), // creator, profile ID (v2: none), reserved
  ];
  return new Uint8Array([...header, ...u32(tags.length), ...table, ...data]);
}

export const FROM_PDF = [pdfToWord, pdfToPpt, pdfToExcel, pdfToMarkdown, pdfToPdfa];
