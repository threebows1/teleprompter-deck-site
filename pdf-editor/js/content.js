// Reads a page's content stream well enough to find where each piece of text
// is drawn, and writes it back with chosen text-drawing commands taken out.
// That is what lets Edit PDF change or delete text that is already in a PDF.

const { PDFName, PDFArray, PDFRawStream, decodePDFRawStream } = window.PDFLib;

/* ---------- tokenizer ---------- */

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
const isRegular = (c) => !WS.has(c) && !DELIM.has(c);
const STRING = { str: true };

// Returns every operator with its operands and the byte range it covers.
export function parseOps(b) {
  const n = b.length;
  let i = 0;
  const ops = [];

  const skipSpace = () => {
    for (;;) {
      while (i < n && WS.has(b[i])) i++;
      if (b[i] === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // % comment
      return;
    }
  };
  const word = () => { const s = i; while (i < n && isRegular(b[i])) i++; return String.fromCharCode(...b.subarray(s, i)); };

  // One operand. Returns undefined at an operator (i left on it).
  const value = () => {
    const c = b[i];
    if (c === 40) { // (literal string)
      let depth = 0;
      for (; i < n; i++) {
        if (b[i] === 92) { i++; continue; }
        if (b[i] === 40) depth++;
        else if (b[i] === 41 && --depth === 0) { i++; break; }
      }
      return STRING;
    }
    if (c === 60 && b[i + 1] === 60) { // << dict >>
      i += 2;
      const d = [];
      for (;;) {
        skipSpace();
        if (i >= n) break;
        if (b[i] === 62 && b[i + 1] === 62) { i += 2; break; }
        const v = value();
        if (v === undefined) word(); else d.push(v);
      }
      return d;
    }
    if (c === 60) { while (i < n && b[i] !== 62) i++; i++; return STRING; } // <hex>
    if (c === 91) { // [ array ]
      i++;
      const a = [];
      for (;;) {
        skipSpace();
        if (i >= n) break;
        if (b[i] === 93) { i++; break; }
        const v = value();
        if (v === undefined) word(); else a.push(v);
      }
      return a;
    }
    if (c === 47) { i++; return { name: word() }; }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { const w = word(); return parseFloat(w) || 0; }
    if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) { i++; return null; } // stray delimiter
    const s = i;
    const w = word();
    if (w === 'true' || w === 'false' || w === 'null') return w;
    i = s;
    return undefined;
  };

  let args = [];
  let argStart = -1;
  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const start = i;
    const v = value();
    if (v !== undefined) {
      if (argStart < 0) argStart = start;
      args.push(v);
      continue;
    }
    const op = word();
    if (!op) { i++; continue; }
    if (op === 'BI') { // inline image: skip its binary data up to EI
      const id = indexOfWord(b, 'ID', i);
      let j = id < 0 ? n : id + 3;
      for (; j < n - 1; j++) {
        if (b[j] === 69 && b[j + 1] === 73 && WS.has(b[j - 1]) && (j + 2 >= n || WS.has(b[j + 2]))) { j += 2; break; }
      }
      i = Math.min(j, n);
    }
    ops.push({ op, args, start: argStart >= 0 ? argStart : start, end: i });
    args = [];
    argStart = -1;
  }
  return ops;
}

function indexOfWord(b, w, from) {
  const c0 = w.charCodeAt(0), c1 = w.charCodeAt(1);
  for (let j = from; j < b.length - 1; j++) {
    if (b[j] === c0 && b[j + 1] === c1 && (j === 0 || WS.has(b[j - 1])) && (j + 2 >= b.length || WS.has(b[j + 2]))) return j;
  }
  return -1;
}

/* ---------- interpreter ---------- */

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const ID = [1, 0, 0, 1, 0, 0];
const num = (a, k) => (typeof a[k] === 'number' ? a[k] : 0);
const cmyk = (c, m, y, k) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];

const SHOW = new Set(['Tj', 'TJ', "'", '"']);

// Where each text-showing operator starts, in PDF user space, and its fill colour.
export function findShows(ops) {
  let ctm = ID, tm = ID, tlm = ID, tl = 0, fill = [0, 0, 0];
  const stack = [];
  const shows = [];
  const td = (x, y) => { tlm = mul([1, 0, 0, 1, x, y], tlm); tm = tlm; };
  ops.forEach((o, k) => {
    const a = o.args;
    switch (o.op) {
      case 'q': stack.push({ ctm, fill }); break;
      case 'Q': if (stack.length) ({ ctm, fill } = stack.pop()); break;
      case 'cm': ctm = mul(a.slice(0, 6).map((_, j) => num(a, j)), ctm); break;
      case 'BT': tm = tlm = ID; break;
      case 'TL': tl = num(a, 0); break;
      case 'Td': td(num(a, 0), num(a, 1)); break;
      case 'TD': tl = -num(a, 1); td(num(a, 0), num(a, 1)); break;
      case 'Tm': tm = tlm = a.slice(0, 6).map((_, j) => num(a, j)); break;
      case 'T*': td(0, -tl); break;
      case 'g': fill = [num(a, 0), num(a, 0), num(a, 0)]; break;
      case 'rg': fill = [num(a, 0), num(a, 1), num(a, 2)]; break;
      case 'k': fill = cmyk(num(a, 0), num(a, 1), num(a, 2), num(a, 3)); break;
      case 'cs': fill = [0, 0, 0]; break;
      case 'sc': case 'scn': {
        const v = a.filter((x) => typeof x === 'number');
        if (v.length === 1) fill = [v[0], v[0], v[0]];
        else if (v.length === 3) fill = v;
        else if (v.length === 4) fill = cmyk(...v);
        break;
      }
      default:
        if (SHOW.has(o.op)) {
          if (o.op === "'" || o.op === '"') td(0, -tl);
          const m = mul(tm, ctm);
          shows.push({ k, x: m[4], y: m[5], color: fill });
        }
    }
  });
  return shows;
}

/* ---------- page streams ---------- */

function streamsOf(lib, page) {
  const c = page.node.Contents();
  if (!c) return [];
  const list = c instanceof PDFArray ? c.asArray().map((r) => lib.context.lookup(r)) : [c];
  return list.filter(Boolean);
}

function bytesOf(stream) {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  return stream.getUnencodedContents?.() || stream.getContents();
}

// The page's whole content, parsed.
export function readPage(lib, index) {
  const page = lib.getPage(index);
  const parts = streamsOf(lib, page).map(bytesOf);
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; bytes[at++] = 10; }
  const ops = parseOps(bytes);
  return { page, bytes, ops, shows: findShows(ops) };
}

// Writes the page back without the operators whose indexes are in `drop`.
// ' and " also move to the next line, so they leave that part behind.
export function dropOps(lib, read, drop) {
  const { bytes, ops, page } = read;
  const enc = new TextEncoder();
  const chunks = [];
  let at = 0;
  [...drop].sort((x, y) => x - y).forEach((k) => {
    const o = ops[k];
    chunks.push(bytes.subarray(at, o.start));
    if (o.op === "'") chunks.push(enc.encode(' T* '));
    else if (o.op === '"') chunks.push(enc.encode(` ${num(o.args, 0)} Tw ${num(o.args, 1)} Tc T* `));
    else chunks.push(enc.encode(' '));
    at = o.end;
  });
  chunks.push(bytes.subarray(at));
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  const ref = lib.context.register(lib.context.flateStream(out));
  page.node.set(PDFName.of('Contents'), ref);
}

/* ---------- matching pdf.js text items to operators ---------- */

// For each text item pdf.js found: the operators that draw it (own), or,
// when pdf.js split one operator into several items, the operator it came
// from (parent). Both are indexes into read.ops.
export function matchItems(items, shows) {
  const geo = items.map((it) => {
    const t = it.transform;
    const hgt = Math.hypot(t[2], t[3]) || 1;
    const len = Math.hypot(t[0], t[1]) || 1;
    return { sx: t[4], sy: t[5], dx: t[0] / len, dy: t[1] / len, h: hgt, w: it.width };
  });
  const local = (g, s) => {
    const ux = s.x - g.sx, uy = s.y - g.sy;
    return { along: ux * g.dx + uy * g.dy, across: -ux * g.dy + uy * g.dx };
  };
  items.forEach((it) => { it.own = []; it.parent = -1; });
  for (const s of shows) {
    let best = -1, bestScore = Infinity;
    geo.forEach((g, j) => {
      if (!items[j].str) return; // pdf.js adds empty markers at line starts
      const { along, across } = local(g, s);
      if (Math.abs(across) > g.h * 0.4 || along < -g.h * 0.3 || along > g.w + g.h * 0.3) return;
      // Closest item *start* wins, so a command beginning mid-line goes to
      // the item that begins there, not to the one it falls inside.
      const score = Math.abs(across) + Math.abs(along);
      if (score < bestScore) { bestScore = score; best = j; }
    });
    if (best >= 0) { items[best].own.push(s.k); s.item = best; }
  }
  items.forEach((it, j) => {
    if (it.own.length) return;
    const g = geo[j];
    let best = -1, bestAlong = -Infinity;
    for (const s of shows) {
      const { along, across } = local(g, s);
      if (Math.abs(across) <= g.h * 0.4 && along <= g.h * 0.3 && along > bestAlong) { bestAlong = along; best = s.k; }
    }
    it.parent = best;
  });
  for (const it of items) it.color = colorOf(shows, it.own[0] ?? it.parent);
}

function colorOf(shows, k) {
  const s = shows.find((x) => x.k === k);
  const c = s ? s.color : [0, 0, 0];
  return '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

const opsOf = (it) => (it.own.length ? it.own : it.parent >= 0 ? [it.parent] : []);

// Everything that has to come out for the `removed` items to disappear, and
// the untouched items that go down with them (and must be drawn again).
export function plan(items, removed) {
  const drop = new Set();
  removed.forEach((j) => opsOf(items[j]).forEach((k) => drop.add(k)));
  const hit = new Set(removed);
  for (let grew = true; grew;) {
    grew = false;
    items.forEach((it, j) => {
      if (hit.has(j)) return;
      if (opsOf(it).some((k) => drop.has(k))) {
        hit.add(j);
        opsOf(it).forEach((k) => drop.add(k));
        grew = true;
      }
    });
  }
  const redraw = [...hit].filter((j) => !removed.has(j));
  const cover = [...removed].filter((j) => !opsOf(items[j]).length);
  return { drop, redraw, cover };
}
