// Pages: home (hero + every tool), the workspace (recent files, favourites)
// and the shell every tool runs in: pick files -> work -> download.
import { h, icon, busy, toast, tick, openPdf, isPdf, isImage, pickFiles, download, fmtSize, modal } from './core.js';
import { TOOLS, CATEGORIES } from './tools.js';
import { listDocs, getDoc, deleteDoc, saveDoc, usedBytes, LIMIT, keepCopies, setKeepCopies, favorites, toggleFavorite } from './store.js';

const app = document.getElementById('app');
const toolById = (id) => TOOLS.find((t) => t.id === id);

// Files handed to a tool from the workspace ("Open in…").
let pending = null;

function route() {
  const [id, sub] = location.hash.slice(1).split('/');
  const tool = toolById(id);
  dropHandler = null;
  document.body.classList.remove('has-bar');
  document.querySelectorAll('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.nav === (tool ? 'tools' : id || 'home')));
  if (tool) { window.scrollTo(0, 0); showTool(tool); return; }
  if (id === 'workspace') { window.scrollTo(0, 0); showWorkspace(sub || 'overview'); return; }
  showHome();
  if (id === 'tools') requestAnimationFrame(() => document.getElementById('all-tools')?.scrollIntoView({ behavior: 'smooth' }));
  else window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
document.querySelector('[data-home]').addEventListener('click', (e) => {
  if (location.hash) { e.preventDefault(); location.hash = ''; }
});

/* ---------- home: hero (concept 01) + tool collection (concept 04) ---------- */

let filter = 'all';
let query = '';

function showHome() {
  document.title = 'PDF Tools · My Second Wish';
  const hero = h('section', { class: 'hero card-lg' },
    h('div', { class: 'hero__text' },
      h('p', { class: 'pill' }, 'Free · Private · In your browser'),
      h('h1', {}, 'Every document.', h('br'), h('span', { class: 'accent' }, 'Beautifully simple.')),
      h('p', { class: 'hero__lead' }, 'Edit, convert, organize and sign PDFs in one calm workspace. Your files never leave your device.'),
      h('div', { class: 'hero__cta' },
        h('a', { class: 'btn btn--solid btn--big', href: '#workspace' }, 'Start working', icon('arrow')),
        h('a', { class: 'btn btn--soft btn--big', href: '#tools' }, 'Explore tools'))),
    h('div', { class: 'hero__art', 'aria-hidden': 'true' },
      h('div', { class: 'art__frame' },
        h('div', { class: 'art__doc' },
          h('i', { class: 'l l--a' }), h('i', { class: 'l l--b' }),
          h('div', { class: 'art__block' }, h('i', { class: 'l l--c' }), h('i', { class: 'l l--d' }), h('i', { class: 'l l--e' })),
          h('i', { class: 'l l--f' }), h('i', { class: 'l l--g' })),
        h('span', { class: 'art__chip art__chip--pdf' }, 'PDF', icon('plus')),
        h('span', { class: 'art__chip art__chip--edit' }, 'EDIT'),
        h('span', { class: 'art__sig' }, icon('sign')))),
    h('div', { class: 'hero__perks' },
      [['shield', 'Private by design', 'Nothing is uploaded'], ['bolt', 'Built for speed', 'Starts the moment you pick a file'], ['heart', 'One seamless flow', 'Free, no account, no watermark']]
        .map(([ic, t, s]) => h('div', { class: 'perk' }, h('span', { class: 'perk__icon' }, icon(ic)), h('div', {}, h('strong', {}, t), h('span', {}, s))))));

  const grid = h('div', { class: 'tools' });
  const empty = h('p', { class: 'empty', hidden: true }, 'No tool matches that. Try “merge”, “sign” or “jpg”.');
  const fill = () => {
    const q = query.trim().toLowerCase();
    const list = TOOLS.filter((t) => (filter === 'all' || t.cat === filter || (filter === 'favs' && favorites().includes(t.id)))
      && (!q || `${t.title} ${t.desc} ${t.cat} ${t.keywords || ''}`.toLowerCase().includes(q)));
    grid.replaceChildren(...list.map(tile));
    empty.hidden = list.length > 0;
  };
  const search = h('input', { class: 'search__input', type: 'search', placeholder: 'Search tools, formats or actions…', 'aria-label': 'Search tools', value: query, oninput: (e) => { query = e.target.value; fill(); } });
  const chips = h('div', { class: 'chips', role: 'tablist' },
    [['all', 'All'], ['favs', '★ Favorites'], ...CATEGORIES].map(([id, label]) =>
      h('button', {
        class: 'chip' + (filter === id ? ' on' : ''), role: 'tab', 'aria-selected': String(filter === id),
        onclick: (e) => { filter = id; chips.querySelectorAll('.chip').forEach((c) => { c.classList.toggle('on', c === e.currentTarget); c.setAttribute('aria-selected', String(c === e.currentTarget)); }); fill(); },
      }, label)));
  fill();
  app.replaceChildren(hero,
    h('section', { class: 'collection', id: 'all-tools' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Everything your PDF needs'), h('p', {}, `${TOOLS.length} tools, all free, all on your device.`)),
      h('form', { class: 'search', role: 'search', onsubmit: (e) => { e.preventDefault(); const first = grid.querySelector('.tile'); if (first) location.hash = first.getAttribute('href'); } },
        icon('search'), search, h('button', { class: 'btn btn--solid', type: 'submit' }, 'Search')),
      chips, grid, empty));
}

function tile(t) {
  const fav = favorites().includes(t.id);
  const star = h('button', {
    class: 'star' + (fav ? ' on' : ''), type: 'button', title: fav ? 'Remove from favorites' : 'Add to favorites', 'aria-label': `Favorite ${t.title}`, 'aria-pressed': String(fav),
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); const on = toggleFavorite(t.id); star.classList.toggle('on', on); star.setAttribute('aria-pressed', String(on)); },
  }, icon('star'));
  return h('a', { class: 'tile', href: '#' + t.id, style: { '--c': t.color } },
    h('span', { class: 'tile__icon' }, icon(t.icon)),
    h('strong', {}, t.title),
    h('span', { class: 'tile__desc' }, t.desc),
    star);
}

/* ---------- workspace (concept 02) ---------- */

const NAV = [['overview', 'grid', 'Overview'], ['tools', 'pages', 'All tools'], ['docs', 'file', 'My documents'], ['favs', 'star', 'Favorites']];
const QUICK = [['edit', 'Make changes'], ['pdf-to-jpg', 'Change format'], ['merge', 'Combine files'], ['compress', 'Save space']];

async function showWorkspace(view) {
  document.title = 'Workspace · PDF Tools';
  const storage = h('div', { class: 'storage' });
  const side = h('aside', { class: 'ws-nav' },
    h('nav', {}, NAV.map(([id, ic, label]) => h('a', { class: 'ws-link' + (view === id ? ' on' : ''), href: '#workspace/' + id }, icon(ic), label))),
    storage);
  const body = h('div', { class: 'ws-body' });
  app.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Your workspace'), h('p', { class: 'crumbs' }, h('a', { href: '#' }, 'Home'), ' / ', view === 'overview' ? 'Overview' : NAV.find((n) => n[0] === view)?.[2])),
    h('div', { class: 'ws' }, side, body));

  const drawStorage = async () => {
    const used = await usedBytes();
    storage.replaceChildren(
      h('p', { class: 'storage__label' }, 'Storage on this device'),
      h('strong', {}, `${fmtSize(used)} of ${fmtSize(LIMIT)}`),
      h('div', { class: 'meter' }, h('span', { style: { width: Math.max(2, Math.min(100, (used / LIMIT) * 100)) + '%' } })),
      h('label', { class: 'check check--dark' }, h('input', { type: 'checkbox', checked: keepCopies(), onchange: (e) => setKeepCopies(e.target.checked) }), h('span', {}, 'Keep finished files here')));
  };
  drawStorage();

  const docsCard = async (limit) => {
    const docs = await listDocs();
    const shown = limit ? docs.slice(0, limit) : docs;
    const card = h('section', { class: 'card-lg docs' },
      h('div', { class: 'docs__head' }, h('h2', {}, limit ? 'Recent documents' : 'My documents'),
        limit && docs.length > limit ? h('a', { class: 'linkbtn', href: '#workspace/docs' }, 'View all', icon('arrow')) : null));
    if (!shown.length) {
      card.append(h('div', { class: 'docs__empty' }, h('span', { class: 'docs__icon' }, icon('file')),
        h('p', {}, 'Files you upload here, and files you finish in any tool, show up in this list. They are kept only in this browser.')));
      return card;
    }
    card.append(h('ul', { class: 'docs__list' }, shown.map((d) => docRow(d, async () => { await deleteDoc(d.id); drawStorage(); render(); }))));
    return card;
  };

  const upload = async () => {
    const files = (await pickFiles({ accept: 'application/pdf,.pdf,image/*', multiple: true })).filter((f) => isPdf(f) || isImage(f));
    if (!files.length) return;
    for (const f of files) await saveDoc({ name: f.name, bytes: f, type: f.type, tool: 'upload' });
    drawStorage();
    await render();
    if (files.length === 1) chooseTool(files[0]);
    else toast(`${files.length} files added to My documents.`);
  };

  const render = async () => {
    if (view === 'docs') { body.replaceChildren(await docsCard(0)); return; }
    if (view === 'tools' || view === 'favs') {
      const list = view === 'favs' ? TOOLS.filter((t) => favorites().includes(t.id)) : TOOLS;
      body.replaceChildren(h('section', {},
        h('div', { class: 'tools tools--ws' }, list.map(tile)),
        view === 'favs' && h('p', { class: 'muted small ws-hint' }, 'Tap the star on any tool to add it here.')));
      return;
    }
    body.replaceChildren(
      h('section', { class: 'welcome' },
        h('div', {}, h('h2', {}, 'Welcome back.'), h('p', {}, 'What would you like to do today?')),
        h('button', { class: 'btn btn--solid btn--big', onclick: upload }, icon('plus'), 'Upload a PDF')),
      h('div', { class: 'quick' }, QUICK.map(([id, sub]) => {
        const t = toolById(id);
        return h('a', { class: 'quick__card', href: '#' + id, style: { '--c': t.color } }, h('span', { class: 'tile__icon' }, icon(t.icon)), h('strong', {}, t.title.replace(' to JPG', ' → JPG')), h('span', {}, sub));
      })),
      await docsCard(5));
  };
  await render();
}

function docRow(d, onDelete) {
  const isImg = !/pdf/i.test(d.type);
  const open = async (toolId) => {
    const rec = await getDoc(d.id);
    if (!rec) return toast('That file is no longer here.', 'bad');
    pending = { tool: toolId, files: [new File([rec.blob], rec.name, { type: rec.type })] };
    location.hash = toolId;
  };
  const choices = TOOLS.filter((t) => kindOf(t) === (isImg ? 'image' : 'pdf'));
  return h('li', { class: 'doc' },
    h('span', { class: 'doc__icon' + (isImg ? ' doc__icon--img' : '') }, isImg ? 'IMG' : 'PDF'),
    h('div', { class: 'doc__meta' }, h('strong', { title: d.name }, d.name),
      h('span', {}, `${when(d.added)} · ${fmtSize(d.size)}${d.tool && d.tool !== 'upload' ? ' · ' + (toolById(d.tool)?.title || '') : ''}`)),
    h('select', { class: 'field doc__open', 'aria-label': `Open ${d.name} in a tool`, onchange: (e) => e.target.value && open(e.target.value) },
      h('option', { value: '' }, 'Open in…'), choices.map((t) => h('option', { value: t.id }, t.title))),
    h('button', { class: 'iconbtn', title: 'Download', 'aria-label': `Download ${d.name}`, onclick: async () => { const r = await getDoc(d.id); if (r) download(r.blob, r.name, r.type); } }, icon('download')),
    h('button', { class: 'iconbtn', title: 'Delete', 'aria-label': `Delete ${d.name}`, onclick: onDelete }, icon('trash')));
}

function when(ts) {
  const d = new Date(ts), now = new Date();
  const day = 864e5;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startToday) return 'Today, ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (ts >= startToday - day) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

async function chooseTool(file) {
  const img = isImage(file);
  const picked = await modal({
    title: `What should we do with “${file.name}”?`,
    wide: true,
    cancelText: 'Later',
    okText: 'Open',
    body: (m) => {
      let choice = img ? 'jpg-to-pdf' : 'edit';
      m.value = () => choice;
      const g = h('div', { class: 'pick' }, TOOLS.filter((t) => kindOf(t) === (img ? 'image' : 'pdf')).map((t) =>
        h('button', { type: 'button', class: 'pick__item' + (t.id === choice ? ' on' : ''), style: { '--c': t.color }, onclick: (e) => { choice = t.id; g.querySelectorAll('.pick__item').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); }, ondblclick: () => m.ok() },
          h('span', { class: 'tile__icon' }, icon(t.icon)), h('span', {}, t.title))));
      return [h('p', {}, 'It is saved in My documents. Pick a tool to open it now.'), g];
    },
  });
  if (!picked) return;
  pending = { tool: picked, files: [file] };
  location.hash = picked;
}

/* ---------- one tool ---------- */

function showTool(tool) {
  document.title = `${tool.title} · PDF Tools`;
  const head = h('div', { class: 'page-head tool__head', style: { '--c': tool.color } },
    h('p', { class: 'crumbs' }, h('a', { href: '#tools' }, 'All tools'), ' / ', tool.title),
    h('div', { class: 'tool__title' },
      h('span', { class: 'tile__icon' }, icon(tool.icon)),
      h('h1', {}, tool.title),
      h('p', {}, tool.long || tool.desc)));
  const body = h('div', { class: 'tool__body' });
  app.replaceChildren(h('section', { class: 'tool', style: { '--c': tool.color } }, head, body));
  showDrop(tool, body);
}

// tool.accept: 'pdf' (default), 'image', or { accept: '.docx,...', test(file), label: 'Word files' }
// for other kinds. Only PDFs are opened up front; other files reach the tool as { file, name, size }.
const kindOf = (tool) => (typeof tool.accept === 'object' ? 'other' : tool.accept === 'image' ? 'image' : 'pdf');
const acceptOf = (tool) => ({ image: 'image/*', pdf: 'application/pdf,.pdf', other: tool.accept?.accept })[kindOf(tool)];
const accepts = (tool, f) => ({ image: isImage, pdf: isPdf, other: (x) => tool.accept.test(x) })[kindOf(tool)](f);
const labelOf = (tool) => ({ image: 'images', pdf: 'PDF files', other: tool.accept?.label || 'files' })[kindOf(tool)];

function showDrop(tool, body) {
  const pick = async () => onFiles(await pickFiles({ accept: acceptOf(tool), multiple: !!tool.multiple }));
  const onFiles = async (files) => {
    files = files.filter((f) => accepts(tool, f));
    if (!files.length) return toast(`Choose ${kindOf(tool) === 'image' ? 'image files (JPG, PNG, WebP)' : labelOf(tool)}.`, 'bad');
    if (!tool.multiple) files = files.slice(0, 1);
    const items = await openAll(tool, files);
    if (items.length) startWork(tool, body, items);
  };
  const kind = kindOf(tool);
  const img = kind === 'image';
  const what = kind === 'other' ? tool.accept.label : null;
  const zone = h('div', { class: 'drop' },
    h('span', { class: 'drop__icon', 'aria-hidden': 'true' }, icon(img ? 'image' : 'upload')),
    h('h2', { class: 'drop__title' }, what ? `Choose ${tool.multiple ? 'your' : 'a'} ${what}` : img ? (tool.multiple ? 'Choose your images' : 'Choose an image') : (tool.multiple ? 'Choose your PDF files' : 'Choose a PDF file')),
    h('p', { class: 'drop__or' }, img ? 'Drag and drop JPG, PNG or WebP images here, or' : 'Drag and drop here, or'),
    h('button', { class: 'btn btn--solid btn--big', onclick: pick }, icon('plus'), what ? `Select ${what}` : img ? 'Select images' : (tool.multiple ? 'Select PDF files' : 'Select PDF file')),
    // Extra ways in (camera, a web address…): tool.dropExtra(start) returns nodes;
    // start(items) skips straight to the workspace with items the tool made.
    tool.dropExtra && h('div', { class: 'drop__extra' }, tool.dropExtra((items) => startWork(tool, body, items))),
    h('p', { class: 'drop__note' }, icon('shield'), 'Opened on this device, never uploaded'));
  dropHandler = onFiles;
  document.body.classList.remove('has-bar');
  body.replaceChildren(zone);
  if (pending && pending.tool === tool.id) {
    const files = pending.files;
    pending = null;
    onFiles(files);
  }
}

async function openAll(tool, files) {
  const out = [];
  for (const [i, f] of files.entries()) {
    if (kindOf(tool) !== 'pdf') { out.push({ file: f, name: f.name, size: f.size }); continue; }
    busy(files.length > 1 ? `Opening ${i + 1} of ${files.length}…` : 'Opening…');
    await tick();
    try {
      out.push(await openPdf(f));
    } catch (err) {
      busy(false);
      if (err.message !== 'cancelled') toast(err.message, 'bad');
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

function startWork(tool, body, items) {
  const main = h('div', { class: 'work__main' });
  const side = h('aside', { class: 'work__side' });
  // Tools write `cond && node`; skip the falses.
  for (const el of [main, side]) el.append = (...kids) => Element.prototype.append.apply(el, kids.filter((k) => k != null && k !== false));
  const action = h('button', { class: 'btn btn--solid btn--big btn--block' }, tool.action || tool.title, icon('arrow'));
  const sideWrap = h('div', { class: 'work__sidewrap' },
    h('div', { class: 'work__sidehead' }, h('h2', {}, tool.editor ? (tool.id === 'sign' ? 'Signature' : 'Properties') : 'Options'),
      h('button', { class: 'linkbtn', onclick: () => showDrop(tool, body) }, tool.multiple ? 'Start over' : 'Change file')),
    side,
    h('div', { class: 'work__go' }, action));
  body.replaceChildren(h('div', { class: 'work' + (tool.wide ? ' work--wide' : '') + (tool.editor ? ' work--editor' : '') }, main, sideWrap));
  document.body.classList.add('has-bar');

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

// What people usually do next, iLovePDF-style.
const NEXT = {
  merge: ['compress', 'organize', 'page-numbers', 'protect'],
  split: ['merge', 'compress', 'organize', 'pdf-to-jpg'],
  'jpg-to-pdf': ['compress', 'merge', 'sign', 'protect'],
  'pdf-to-jpg': ['jpg-to-pdf', 'compress', 'split', 'edit'],
  protect: ['unlock', 'compress', 'sign', 'merge'],
  scan: ['ocr', 'compress', 'merge', 'sign'],
  ocr: ['pdf-to-word', 'compress', 'redact', 'translate'],
  repair: ['compress', 'ocr', 'unlock', 'merge'],
  redact: ['protect', 'compress', 'sign', 'merge'],
  forms: ['sign', 'protect', 'compress', 'merge'],
  translate: ['compress', 'summarize', 'pdf-to-word', 'sign'],
  'word-to-pdf': ['compress', 'merge', 'sign', 'protect'],
  'ppt-to-pdf': ['compress', 'merge', 'sign', 'protect'],
  'excel-to-pdf': ['compress', 'merge', 'sign', 'protect'],
  'html-to-pdf': ['compress', 'merge', 'sign', 'protect'],
};
const FALLBACK = ['compress', 'merge', 'edit', 'sign', 'protect', 'split'];

// result: { files: [{ name, bytes, type? }], note?, zipName?, title? }
function showDone(tool, body, result) {
  dropHandler = null;
  document.body.classList.remove('has-bar');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const next = (NEXT[tool.id] || FALLBACK).filter((id) => id !== tool.id).slice(0, 4).map(toolById).filter(Boolean);
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
  const kept = h('p', { class: 'done__kept', hidden: true });
  if (keepCopies() && files.length <= 20) {
    Promise.all(files.map((f) => saveDoc({ name: f.name, bytes: f.bytes, type: f.type, tool: tool.id }))).then((ids) => {
      if (!ids.every(Boolean)) return;
      kept.hidden = false;
      kept.replaceChildren(icon('check'), 'Saved to ', h('a', { href: '#workspace/docs' }, 'My documents'), ' on this device.');
    });
  }
  const list = files.length > 1 && h('ul', { class: 'done__list' }, files.slice(0, 50).map((f) =>
    h('li', {}, h('span', {}, f.name), h('button', { class: 'linkbtn', onclick: () => download(f.bytes, f.name, f.type) }, 'Download'))));
  body.replaceChildren(h('div', { class: 'done card-lg' },
    h('span', { class: 'done__check' }, icon('check')),
    h('h2', {}, result.title || 'Your file is ready'),
    result.note && h('p', { class: 'done__note' }, result.note),
    h('button', { class: 'btn btn--solid btn--big', onclick: save }, icon('download'),
      files.length === 1 ? `Download ${files[0].name.split('.').pop().toUpperCase()}` : `Download all (${files.length}) as ZIP`),
    h('p', { class: 'muted' }, files.length === 1 ? `${files[0].name} · ${fmtSize(total)}` : fmtSize(total)),
    kept,
    list,
    h('div', { class: 'done__more' },
      h('button', { class: 'btn btn--soft', onclick: () => showDrop(tool, body) }, icon('rotateLeft'), 'Do another'),
      h('a', { class: 'btn btn--soft', href: '#workspace' }, icon('grid'), 'Workspace')),
    h('div', { class: 'done__next' },
      h('p', { class: 'f__label' }, 'Continue with'),
      h('div', { class: 'nexts' }, next.map((t) => h('a', { class: 'next', href: '#' + t.id, style: { '--c': t.color } },
        h('span', { class: 'tile__icon' }, icon(t.icon)), h('span', {}, t.title)))))));
  save();
}

route();
