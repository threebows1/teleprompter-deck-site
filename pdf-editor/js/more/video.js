// Compress video & images: a smaller MP4 made with the browser's own video
// encoder (WebCodecs, through mediabunny), or photos re-saved smaller with a
// canvas. Nothing leaves the device.
import { h, icon, registerIcons, busy, toast, baseName, fmtSize, isImage, hasAlpha, uid } from '../core.js';
import { field, segmented, choiceCards, check, debounce } from '../ui.js';

registerIcons({
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
});

const isVideo = (f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|3gp)$/i.test(f.name);
let mb;
const lib = () => (mb ||= import('../../vendor/mediabunny/mediabunny.min.js').catch((err) => {
  mb = null;
  console.error(err);
  throw new Error('Could not load a part of PDF Tools. Check your connection and try again.');
}));

// Bits per pixel per frame for H.264: what each level spends on picture.
const LEVELS = { small: 0.045, medium: 0.075, high: 0.12 };
const AUDIO = 128e3;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const clock = (s) => {
  s = Math.round(s);
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};

// What the video holds: size, length, frame rate and how many bits it spends.
async function probe(file) {
  const { Input, BlobSource, ALL_FORMATS } = await lib();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('This file has no video in it.');
    const audio = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    const stats = await video.computePacketStats(120);
    const audioRate = audio ? (await audio.computePacketStats(120)).averageBitrate : 0;
    return {
      width: video.displayWidth, height: video.displayHeight, duration,
      fps: stats.averagePacketRate || 30, videoRate: stats.averageBitrate, audioRate,
      hasAudio: !!audio, canRead: await video.canDecode(), codec: video.codec,
    };
  } finally { input.dispose?.(); }
}

// The output size for a resolution choice: 'p' counts the short side, so a
// phone video held upright stays upright.
function outSize(info, res) {
  const short = Math.min(info.width, info.height);
  const k = res === 'original' || +res >= short ? 1 : +res / short;
  return { width: even(info.width * k), height: even(info.height * k) };
}

function plan(info, s) {
  const { width, height } = outSize(info, s.res);
  let video = width * height * Math.min(info.fps, 60) * LEVELS[s.level];
  // Never spend more than the original did at that size, or the file grows.
  const scaled = info.videoRate * (width * height) / (info.width * info.height);
  if (scaled) video = Math.min(video, scaled * 0.8);
  video = Math.max(150e3, Math.round(video));
  const audio = s.mute || !info.hasAudio ? 0 : Math.min(info.audioRate || AUDIO, 192e3);
  return { width, height, video, estimate: ((video + audio) * info.duration) / 8 };
}

const videoMode = {
  setup(ctx) {
    const it = ctx.items[0];
    const s = ctx.state = { level: 'medium', res: 'original', mute: false };
    const url = URL.createObjectURL(it.file);
    const facts = h('span', {}, fmtSize(it.size));
    const estimate = h('p', { class: 'vid-est' }, 'Reading the video…');
    const resWrap = h('div');
    ctx.action.disabled = true;
    ctx.main.append(h('div', { class: 'vid' },
      h('video', { class: 'vid__player', src: url + '#t=0.1', controls: true, preload: 'metadata', playsinline: true }),
      h('div', { class: 'card__meta' }, h('strong', { title: it.name }, it.name), facts)));
    const update = () => {
      if (!s.info) return;
      const p = plan(s.info, s);
      const pct = Math.round((1 - p.estimate / it.size) * 100);
      estimate.replaceChildren(h('strong', {}, `About ${fmtSize(p.estimate)}`),
        pct > 0 ? ` · ${pct}% smaller` : ' · about the same size', h('br'), `${p.width} × ${p.height}`);
    };
    ctx.side.append(
      choiceCards([
        ['small', 'Smallest file', 'Good for WhatsApp and email'],
        ['medium', 'Recommended', 'Good quality, good saving'],
        ['high', 'High quality', 'Looks like the original, saves less'],
      ], s.level, (v) => { s.level = v; update(); }),
      resWrap,
      check('Remove the sound', s.mute, (v) => { s.mute = v; update(); }),
      estimate,
      h('p', { class: 'muted small' }, 'Long videos take a while: about as long as the video plays, often quicker. Keep this tab open until it is done.'));

    if (!('VideoEncoder' in window)) {
      estimate.textContent = 'This browser cannot compress video. Use Chrome, Edge or Safari.';
      return;
    }
    probe(it.file).then((info) => {
      if (!ctx.main.isConnected) return;
      s.info = info;
      facts.textContent = `${info.width} × ${info.height} · ${clock(info.duration)} · ${fmtSize(it.size)}`;
      const short = Math.min(info.width, info.height);
      const steps = [1080, 720, 480, 360].filter((r) => r < short);
      // 4K and bigger: 1080p is plenty to share, and far quicker to make.
      if (short > 1440) s.res = '1080';
      resWrap.replaceChildren(field('Resolution', segmented([['original', 'Original'], ...steps.map((r) => [String(r), r + 'p'])], s.res, (v) => { s.res = v; update(); })));
      if (!info.canRead) {
        estimate.textContent = `This browser cannot read this video's format (${info.codec || 'unknown'}). Try it in Chrome or Edge, or in Safari on a Mac or iPhone.`;
        return;
      }
      ctx.action.disabled = false;
      update();
    }).catch((err) => {
      console.error(err);
      estimate.textContent = err.message.startsWith('This file') || err.message.startsWith('Could not') ? err.message : 'This video could not be read. It may be damaged, or in a format this browser does not know.';
    });
  },
  async run(ctx) {
    const it = ctx.items[0];
    const s = ctx.state;
    const p = plan(s.info, s);
    const { Input, Output, BlobSource, BufferTarget, Mp4OutputFormat, Conversion, ALL_FORMATS, getFirstEncodableVideoCodec, ConversionCanceledError } = await lib();
    const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
    // H.264 plays everywhere (phones, WhatsApp, Windows); the others only if it can't be made here.
    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'].filter((c) => format.getSupportedVideoCodecs().includes(c)),
      { width: p.width, height: p.height, bitrate: p.video });
    if (!codec) throw new Error('This browser cannot make MP4 video. Try Chrome or Edge.');
    const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
    const output = new Output({ format, target: new BufferTarget() });
    const conversion = await Conversion.init({
      input, output, showWarnings: false,
      video: { width: p.width, height: p.height, fit: 'fill', codec, bitrate: p.video, forceTranscode: true },
      audio: s.mute ? { discard: true } : {},
    });
    if (!conversion.isValid || conversion.discardedTracks.some((d) => d.track.type === 'video')) {
      input.dispose?.();
      throw new Error('This video could not be compressed in this browser. Try Chrome or Edge.');
    }
    const lostSound = !s.mute && conversion.discardedTracks.some((d) => d.track.type === 'audio');

    // A way out of a long job: Cancel in the progress box.
    const box = document.querySelector('.busy__box');
    const stop = h('button', { class: 'btn btn--soft busy__cancel', onclick: () => conversion.cancel() }, icon('x'), 'Cancel');
    box?.append(stop);
    const start = performance.now();
    conversion.onProgress = (k) => {
      const secs = (performance.now() - start) / 1000;
      const left = k > 0.03 && secs > 3 ? Math.round(secs / k - secs) : 0;
      busy(`Compressing… ${Math.floor(k * 100)}%${left ? ` · about ${left < 60 ? `${left} s` : `${Math.ceil(left / 60)} min`} left` : ''}`);
    };
    busy('Compressing… 0%');
    try {
      await conversion.execute();
    } catch (err) {
      if (err instanceof ConversionCanceledError) { toast('Stopped. Your video was not changed.'); return null; }
      console.error(err);
      throw new Error('The video could not be compressed. It may be damaged, or too big for this device.');
    } finally {
      stop.remove();
      input.dispose?.();
    }

    const bytes = output.target.buffer;
    const before = it.size;
    const smaller = bytes.byteLength < before;
    const pct = Math.round((1 - bytes.byteLength / before) * 100);
    const note = [`${p.width} × ${p.height}`, lostSound && 'the sound could not be kept in this browser'].filter(Boolean).join(' · ');
    if (!smaller) {
      return {
        files: [{ name: it.name, bytes: it.file, type: it.file.type || 'video/mp4' }],
        title: 'This video is already compact',
        note: 'It could not be made smaller at this setting, so this is your original file. Try a lower resolution or "Smallest file".',
      };
    }
    return {
      files: [{ name: `${baseName(it.name)}-compressed.mp4`, bytes, type: 'video/mp4' }],
      title: `Your video is ${pct}% smaller`,
      note: `${fmtSize(before)} → ${fmtSize(bytes.byteLength)} · ${note}`,
    };
  },
};

/* ---------- images ---------- */

const QUALITY = { small: 0.6, medium: 0.75, high: 0.86 };
const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

// Re-encodes one picture. 'auto' keeps JPG and WebP as they are, and turns
// PNG (which a browser can only save losslessly) into JPG, or WebP when it
// has see-through parts. Camera details and location go with the re-encode.
async function shrinkImage(file, s) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
    throw new Error(/\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type)
      ? `“${file.name}” is a HEIC photo, which this browser can’t open. Save it as JPG first.`
      : `“${file.name}” can’t be read as an image.`);
  }
  const k = s.max && Math.max(bmp.width, bmp.height) > s.max ? s.max / Math.max(bmp.width, bmp.height) : 1;
  const width = Math.max(1, Math.round(bmp.width * k)), height = Math.max(1, Math.round(bmp.height * k));
  const c = Object.assign(document.createElement('canvas'), { width, height });
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  let type = s.format === 'jpg' ? 'image/jpeg' : s.format === 'webp' ? 'image/webp' : null;
  if (!type) {
    if (/jpe?g/i.test(file.type) || /\.jpe?g$/i.test(file.name)) type = 'image/jpeg';
    else if (/webp/i.test(file.type)) type = 'image/webp';
    else type = hasAlpha(g, width, height) ? 'image/webp' : 'image/jpeg';
  }
  if (type === 'image/jpeg') { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, width, height); }
  let blob = await new Promise((r) => c.toBlob(r, type, QUALITY[s.level]));
  c.width = c.height = 0;
  if (!blob) throw new Error(`“${file.name}” is too large for this device to compress.`);
  // Safari can't write WebP and quietly hands back PNG: say what it really is.
  type = blob.type || type;
  // Bigger than it was, at the same size and kind: the original is the better file.
  const same = k === 1 && file.type === type;
  if (same && blob.size >= file.size) return { blob: file, type, width, height, kept: true };
  return { blob, type, width, height };
}

const imageMode = {
  setup(ctx) {
    const s = ctx.state = { level: 'medium', max: 0, format: 'auto' };
    const urls = new Map();
    const total = h('p', { class: 'vid-est' }, 'Working out the new sizes…');
    let gen = 0;
    const key = () => `${s.level}|${s.max}|${s.format}`;
    const list = h('div', { class: 'cards' });
    const sizeLine = (it) => {
      if (it.err) return h('span', { class: 'vid-bad' }, it.err);
      if (!it.out || it.outKey !== key()) return h('span', {}, `${fmtSize(it.size)} → …`);
      const pct = Math.round((1 - it.out.blob.size / it.size) * 100);
      return h('span', { class: 'vid-size' }, `${fmtSize(it.size)} → `, h('b', {}, fmtSize(it.out.blob.size)), pct > 0 ? ` (−${pct}%)` : ' (no saving)');
    };
    const draw = () => {
      list.replaceChildren(...ctx.items.map((it) => {
        it.uid ||= uid();
        if (!urls.has(it.file)) urls.set(it.file, URL.createObjectURL(it.file));
        return h('div', { class: 'card', 'data-id': it.uid },
          h('div', { class: 'card__page' }, h('img', { class: 'thumb', src: urls.get(it.file), alt: '', style: { imageOrientation: 'from-image' } })),
          h('div', { class: 'card__meta' }, h('strong', { title: it.name }, it.name), sizeLine(it)),
          h('button', { class: 'iconbtn card__x', 'aria-label': `Remove ${it.name}`, onclick: () => { ctx.items.splice(ctx.items.indexOf(it), 1); draw(); refresh(); } }, icon('x')));
      }), h('button', { class: 'card card--add', onclick: async () => add(await ctx.addMore()) }, icon('plus'), 'Add images'));
      const ready = ctx.items.filter((it) => it.out && it.outKey === key());
      const before = ready.reduce((n, it) => n + it.size, 0), after = ready.reduce((n, it) => n + it.out.blob.size, 0);
      total.replaceChildren(ready.length < ctx.items.filter((it) => !it.err).length
        ? `Working out the new sizes… ${ready.length} of ${ctx.items.length}`
        : h('span', {}, h('strong', {}, `${fmtSize(before)} → ${fmtSize(after)}`), before > after ? ` · ${Math.round((1 - after / before) * 100)}% smaller` : ''));
      ctx.action.disabled = !ctx.items.some((it) => !it.err);
    };
    // Compresses each picture in turn for the sizes on the cards; Compress then just hands them over.
    const refresh = debounce(async () => {
      const mine = ++gen, k = key();
      for (const it of ctx.items) {
        if (mine !== gen || !list.isConnected) return;
        if (it.err || (it.out && it.outKey === k)) continue;
        try { it.out = await shrinkImage(it.file, s); it.outKey = k; } catch (err) { it.err = err.message; }
        if (mine === gen && list.isConnected) draw();
      }
    }, 300);
    s.ensure = async () => {
      const k = key();
      for (const [n, it] of ctx.items.entries()) {
        if (it.err || (it.out && it.outKey === k)) continue;
        busy(`Compressing image ${n + 1} of ${ctx.items.length}…`);
        try { it.out = await shrinkImage(it.file, s); it.outKey = k; } catch (err) { it.err = err.message; }
      }
    };
    const add = (more) => {
      const imgs = more.filter((it) => isImage(it.file));
      if (imgs.length < more.length) toast('Videos are compressed one at a time, on their own. Only the images were added.');
      ctx.items.push(...imgs); draw(); refresh();
    };
    ctx.onDropMore = add;
    const change = (k) => (v) => { s[k] = v; draw(); refresh(); };
    ctx.main.append(list);
    ctx.side.append(
      choiceCards([
        ['small', 'Smallest file', 'Good for WhatsApp, email and websites'],
        ['medium', 'Recommended', 'Good quality, good saving'],
        ['high', 'High quality', 'Looks like the original, saves less'],
      ], s.level, change('level')),
      field('Largest side', segmented([[0, 'Original'], [3840, '3840 px'], [1920, '1920 px'], [1280, '1280 px']], s.max, change('max'))),
      field('Save as', segmented([['auto', 'Best'], ['jpg', 'JPG'], ['webp', 'WebP']], s.format, change('format'))),
      total,
      h('p', { class: 'muted small' }, 'Best keeps JPG and WebP as they are and turns PNG into JPG, or WebP when it has see-through parts. Camera details and location are removed.'));
    draw();
    refresh();
  },
  async run(ctx) {
    const s = ctx.state;
    await s.ensure();
    const done = ctx.items.filter((it) => it.out && !it.err);
    const failed = ctx.items.length - done.length;
    if (!done.length) throw new Error(ctx.items.find((it) => it.err)?.err || 'These images could not be compressed.');
    const files = await Promise.all(done.map(async (it) => ({
      name: it.out.kept ? it.name : `${baseName(it.name)}-compressed.${EXT[it.out.type] || 'jpg'}`,
      bytes: new Uint8Array(await it.out.blob.arrayBuffer()), type: it.out.type,
    })));
    const before = done.reduce((n, it) => n + it.size, 0), after = files.reduce((n, f) => n + f.bytes.byteLength, 0);
    const pct = Math.round((1 - after / before) * 100);
    const one = files.length === 1;
    return {
      files, zipName: 'compressed-images.zip',
      title: pct > 0 ? `Your ${one ? 'image is' : 'images are'} ${pct}% smaller` : `${one ? 'This image is' : 'These images are'} already compact`,
      note: [`${fmtSize(before)} → ${fmtSize(after)}`, failed && `${failed} could not be read`].filter(Boolean).join(' · '),
    };
  },
};

/* ---------- the page: one video, or any number of images ---------- */

const compressVideo = {
  id: 'compress-video', keywords: 'video mp4 mov movie clip image photo picture jpg png webp reduce shrink size smaller whatsapp email compress-image', title: 'Compress video & images', icon: 'video', color: '#e11d48', cat: 'optimize',
  accept: { accept: 'video/*,.mp4,.m4v,.mov,.webm,.mkv,.3gp,image/*,.heic,.heif', test: (f) => isVideo(f) || isImage(f), label: 'video or images' },
  multiple: true, action: 'Compress', busyText: 'Getting ready…',
  desc: 'Make videos and photos smaller to send or share.',
  long: 'Shrink a video (MP4, MOV, WebM) into a smaller MP4, or many photos (JPG, PNG, WebP) at once. Pick how small, and a lower size for a bigger saving.',
  setup(ctx) {
    const vids = ctx.items.filter((it) => isVideo(it.file));
    if (vids.length) {
      if (ctx.items.length > 1) toast(`One video at a time: compressing “${vids[0].name}”.`);
      ctx.items.splice(0, ctx.items.length, vids[0]);
    }
    ctx.mode = vids.length ? videoMode : imageMode;
    ctx.action.firstChild.nodeValue = vids.length ? 'Compress video' : ctx.items.length > 1 ? 'Compress images' : 'Compress image';
    ctx.mode.setup(ctx);
  },
  run: (ctx) => ctx.mode.run(ctx),
};

export const VIDEO = [compressVideo];
