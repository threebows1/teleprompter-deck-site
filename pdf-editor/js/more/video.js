// Compress video: makes a smaller MP4 with the browser's own video encoder
// (WebCodecs, through mediabunny). Nothing leaves the device.
import { h, icon, registerIcons, busy, toast, baseName, fmtSize } from '../core.js';
import { field, segmented, choiceCards, check } from '../ui.js';

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

const compressVideo = {
  id: 'compress-video', keywords: 'video mp4 mov movie clip reduce shrink size smaller whatsapp email', title: 'Compress video', icon: 'video', color: '#e11d48', cat: 'optimize',
  accept: { accept: 'video/*,.mp4,.m4v,.mov,.webm,.mkv,.3gp', test: isVideo, label: 'video' },
  action: 'Compress video', busyText: 'Getting ready…',
  desc: 'Make a video smaller to send or share.',
  long: 'Shrink MP4, MOV and WebM videos into a smaller MP4. Pick how small, and a lower resolution for a bigger saving.',
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

export const VIDEO = [compressVideo];
