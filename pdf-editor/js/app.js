// The tool grid and the shell every tool runs in: pick files -> work -> download.
import { h, icon, busy, toast, tick, openPdf, isPdf, isImage, pickFiles, download, fmtSize, baseName } from './core.js';
import { TOOLS, CATEGORIES } from './tools.js';

const app = document.getElementById('app');

function route() {
  const id = location.hash.slice(1);
  const tool = TOOLS.find((t) => t.id === id);
  window.scrollTo(0, 0);
  if (tool) showTool(tool);
  else showHome();
}
window.addEventListener('hashchange', route);
document.querySelector('[data-home]').addEventListener('click', (e) => {
  if (location.hash) { e.preventDefault(); location.hash = ''; }
});

/* ---------- home ---------- */

let filter = 'all';
function showHome() {
  dropHandler = null;
  document.title = 'PDF Tools · My Second Wish';
  const grid = h('div', { class: 'tools' });
  const fill = () => {
    grid.replaceChildren(...TOOLS.filter((t) => filter === 'all' || t.cat === filter).map((t) =>
      h('a', { class: 'tile', href: '#' + t.id, style: { '--c': t.color } },
        h('span', { class: 'tile__icon' }, icon(t.icon)),
        h('strong', {}, t.title),
        h('span', {}, t.desc))));
  };
  const chips = h('div', { class: 'chips', role: 'tablist' },
    [['all', 'All'], ...CATEGORIES].map(([id, label]) =>
      h('button', {
        class: 'chip' + (filter === id ? ' on' : ''), role: 'tab', 'aria-selected': String(filter === id),
        onclick: (e) => { filter = id; chips.querySelectorAll('.chip').forEach((c) => { c.classList.toggle('on', c === e.currentTarget); c.setAttribute('aria-selected', String(c === e.currentTarget)); }); fill(); },
      }, label)));
  fill();
  app.replaceChildren(
    h('section', { class: 'hero' },
      h('p', { class: 'eyebrow' }, 'Free · No sign-up · Nothing uploaded'),
      h('h1', {}, 'Every PDF tool, ', h('span', { class: 'grad' }, 'right in your browser.')),
      h('p', {}, 'Merge, split, compress, edit and sign PDFs, and convert them to and from images. Your files stay on your device: everything runs here, in this page.')),
    chips, grid);
}

/* ---------- one tool ---------- */

function showTool(tool) {
  document.title = `${tool.title} · PDF Tools`;
  const head = h('div', { class: 'tool__head', style: { '--c': tool.color } },
    h('a', { class: 'back', href: '#', 'aria-label': 'All tools' }, icon('back'), 'All tools'),
    h('div', { class: 'tool__title' },
      h('span', { class: 'tile__icon' }, icon(tool.icon)),
      h('div', {}, h('h1', {}, tool.title), h('p', {}, tool.long || tool.desc))));
  const body = h('div', { class: 'tool__body' });
  app.replaceChildren(h('section', { class: 'tool', style: { '--c': tool.color } }, head, body));
  showDrop(tool, body);
}

const acceptOf = (tool) => (tool.accept === 'image' ? 'image/*' : 'application/pdf,.pdf');
const accepts = (tool, f) => (tool.accept === 'image' ? isImage(f) : isPdf(f));

function showDrop(tool, body) {
  const pick = async () => onFiles(await pickFiles({ accept: acceptOf(tool), multiple: !!tool.multiple }));
  const onFiles = async (files) => {
    files = files.filter((f) => accepts(tool, f));
    if (!files.length) return toast(tool.accept === 'image' ? 'Choose image files (JPG, PNG, WebP).' : 'Choose a PDF file.', 'bad');
    if (!tool.multiple) files = files.slice(0, 1);
    const items = await openAll(tool, files);
    if (items.length) startWork(tool, body, items);
  };
  const zone = h('div', { class: 'drop' },
    h('button', { class: 'btn btn--solid btn--big', onclick: pick }, icon('upload'),
      tool.accept === 'image' ? (tool.multiple ? 'Select images' : 'Select image') : (tool.multiple ? 'Select PDF files' : 'Select PDF file')),
    h('p', {}, tool.accept === 'image' ? 'or drop images here' : 'or drop PDFs here'),
    h('p', { class: 'drop__note' }, icon('shield'), 'Files are opened on this device. Nothing is uploaded.'));
  dropTarget(zone, onFiles);
  body.replaceChildren(zone);
}

async function openAll(tool, files) {
  const out = [];
  for (const [i, f] of files.entries()) {
    if (tool.accept === 'image') { out.push({ file: f, name: f.name, size: f.size }); continue; }
    busy(files.length > 1 ? `Opening ${i + 1} of ${files.length}…` : 'Opening…');
    await tick();
    try {
      out.push(await openPdf(f));
    } catch (err) {
      busy(false);
      if (err.message !== 'cancelled') toast(err.message, 'bad');
      busy(files.length > 1 ? 'Opening…' : 'Opening…');
    }
  }
  busy(false);
  return out;
}

// Whole-window drop while a tool is open.
let dropHandler = null;
window.addEventListener('dragover', (e) => { if (dropHandler) { e.preventDefault(); document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => {
  document.body.classList.remove('dragging');
  if (!dropHandler) return;
  e.preventDefault();
  dropHandler([...e.dataTransfer.files]);
});
function dropTarget(el, fn) { dropHandler = fn; }

function startWork(tool, body, items) {
  const main = h('div', { class: 'work__main' });
  const side = h('aside', { class: 'work__side' });
  // Tools write `cond && node`; skip the falses.
  for (const el of [main, side]) el.append = (...kids) => Element.prototype.append.apply(el, kids.filter((k) => k != null && k !== false));
  const action = h('button', { class: 'btn btn--solid btn--big btn--block' }, tool.action || tool.title);
  const sideWrap = h('div', { class: 'work__sidewrap' }, h('h2', {}, tool.title), side, h('div', { class: 'work__go' }, action));
  body.replaceChildren(h('div', { class: 'work' + (tool.wide ? ' work--wide' : '') }, main, sideWrap));

  const ctx = {
    items, main, side, body, action,
    async addMore() {
      const files = (await pickFiles({ accept: acceptOf(tool), multiple: true })).filter((f) => accepts(tool, f));
      return openAll(tool, files);
    },
    restart: () => showDrop(tool, body),
    done: (result) => showDone(tool, body, result),
  };
  dropHandler = tool.multiple ? async (files) => {
    const more = await openAll(tool, files.filter((f) => accepts(tool, f)));
    if (more.length) ctx.onDropMore?.(more);
  } : null;

  action.addEventListener('click', async () => {
    try {
      busy(tool.busyText || 'Working…');
      await tick();
      const result = await tool.run(ctx);
      busy(false);
      if (result) showDone(tool, body, result);
    } catch (err) {
      busy(false);
      console.error(err);
      toast(err.message || 'Something went wrong with this file.', 'bad');
    }
  });
  tool.setup(ctx);
}

// result: { files: [{ name, bytes, type? }], note?, zipName? }
function showDone(tool, body, result) {
  dropHandler = null;
  const files = result.files;
  const save = async () => {
    if (files.length === 1) return download(files[0].bytes, files[0].name, files[0].type);
    busy('Making the ZIP…');
    const zip = new window.JSZip();
    files.forEach((f) => zip.file(f.name, f.bytes));
    const blob = await zip.generateAsync({ type: 'blob' });
    busy(false);
    download(blob, result.zipName || 'pdf-tools.zip', 'application/zip');
  };
  const total = files.reduce((s, f) => s + (f.bytes.byteLength ?? f.bytes.size ?? 0), 0);
  const list = files.length > 1 && h('ul', { class: 'done__list' }, files.slice(0, 50).map((f) =>
    h('li', {}, h('span', {}, f.name), h('button', { class: 'linkbtn', onclick: () => download(f.bytes, f.name, f.type) }, 'Download'))));
  body.replaceChildren(h('div', { class: 'done' },
    h('span', { class: 'done__check' }, icon('check')),
    h('h2', {}, result.title || 'Your file is ready'),
    result.note && h('p', { class: 'done__note' }, result.note),
    h('button', { class: 'btn btn--solid btn--big', onclick: save }, icon('download'),
      files.length === 1 ? `Download ${files[0].name.split('.').pop().toUpperCase()}` : `Download all (${files.length}) as ZIP`),
    h('p', { class: 'muted' }, files.length === 1 ? `${files[0].name} · ${fmtSize(total)}` : fmtSize(total)),
    list,
    h('div', { class: 'done__more' },
      h('button', { class: 'btn btn--ghost', onclick: () => showDrop(tool, body) }, `${tool.title} another file`),
      h('a', { class: 'btn btn--ghost', href: '#' }, 'All tools'))));
  save();
}

route();
