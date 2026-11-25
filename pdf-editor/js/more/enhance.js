// Enhance image: fix a photo of a passport, ID card or paper by hand.
// Brightness, contrast, shadows, colour, sharpness, turn, straighten and
// crop, with a live preview; saved as JPG, PNG or a one-page PDF.
import { h, icon, registerIcons, busy, tick, PDFDocument, baseName } from '../core.js';
import { field, segmented, check, pdfOut } from '../ui.js';
import { FULL, isFull, cropper, turnRect, decode, blurred } from './organize.js';

registerIcons({
  enhance: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/><path d="M12 8h9M12 12h9M12 16h9" opacity=".35"/>',
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const PREVIEW = 1100, MAX_OUT = 4000;
const A4 = [595.28, 841.89];

const SLIDERS = [
  ['brightness', 'Brightness'], ['contrast', 'Contrast'], ['shadows', 'Shadows'],
  ['saturation', 'Colour'], ['warmth', 'Warmth'], ['sharpness', 'Sharpness', 0, 100],
];
const fresh = () => ({
  rot: 0, angle: 0, cut: { ...FULL }, levels: null, even: false, gray: false,
  brightness: 0, contrast: 0, shadows: 0, saturation: 0, warmth: 0, sharpness: 0,
});

// The picture turned (rot, in 90° steps), straightened (angle, zoomed in just
// enough that no empty corners show) and, when asked, cut to s.cut.
function place(src, s, maxSide, withCut) {
  const side = s.rot % 180 !== 0;
  const rw = side ? src.height : src.width, rh = side ? src.width : src.height;
  const r = withCut ? s.cut : FULL;
  const cw = r.w * rw, ch = r.h * rh;
  const k = Math.min(1, maxSide / Math.max(cw, ch));
  const c = h('canvas', { width: Math.max(1, Math.round(cw * k)), height: Math.max(1, Math.round(ch * k)) });
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.scale(k, k);
  x.translate(-r.x * rw + rw / 2, -r.y * rh + rh / 2);
  const a = (s.angle * Math.PI) / 180, cos = Math.cos(Math.abs(a)), sin = Math.sin(Math.abs(a));
  const z = Math.max(cos + (rh / rw) * sin, (rw / rh) * sin + cos);
  x.rotate(a);
  x.scale(z, z);
  x.rotate((s.rot * Math.PI) / 180);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

// Where the darkest and lightest 0.5% of the picture start: Auto fix
// stretches that range to full black and white.
function findLevels(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const hist = new Uint32Array(256);
  for (let o = 0; o < d.length; o += 4) hist[(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]) | 0]++;
  const n = d.length / 4, cut = n * 0.005;
  let lo = 0, hi = 255, sum = 0;
  while (lo < 254 && (sum += hist[lo]) < cut) lo++;
  sum = 0;
  while (hi > lo + 1 && (sum += hist[hi]) < cut) hi--;
  // A picture that already spans the range is left alone.
  return hi - lo > 235 ? null : { lo, hi };
}

// Applies the colour settings to canvas c in place. `sharpScale` is how many
// output pixels one preview pixel stands for, so sharpening looks alike.
function adjust(c, s, sharpScale = 1) {
  const x = c.getContext('2d');
  const img = x.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // One lookup table for levels, brightness, contrast and shadows.
  const lut = new Uint8ClampedArray(256);
  const ct = s.contrast * 1.28;
  const f = (259 * (ct + 255)) / (255 * (259 - ct));
  for (let v = 0; v < 256; v++) {
    let t = v;
    if (s.levels) t = ((t - s.levels.lo) * 255) / (s.levels.hi - s.levels.lo);
    t += (s.shadows / 100) * 90 * (1 - clamp(t, 0, 255) / 255) ** 2;
    t += s.brightness * 1.1;
    t = f * (t - 128) + 128;
    lut[v] = t;
  }
  const paper = s.even ? blurred(c).getContext('2d').getImageData(0, 0, c.width, c.height).data : null;
  const sat = 1 + s.saturation / 100, warm = s.warmth * 0.35;
  for (let o = 0; o < d.length; o += 4) {
    let r = d[o], g = d[o + 1], b = d[o + 2];
    if (paper) {
      // Divide out uneven light: shadowed paper comes up to white, ink stays.
      const p = Math.max(40, 0.299 * paper[o] + 0.587 * paper[o + 1] + 0.114 * paper[o + 2]);
      const k = Math.min(3, 245 / p);
      r *= k; g *= k; b *= k;
      r = r > 255 ? 255 : r; g = g > 255 ? 255 : g; b = b > 255 ? 255 : b;
    }
    r = lut[r | 0]; g = lut[g | 0]; b = lut[b | 0];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (s.gray) { r = g = b = y; } else {
      r = y + (r - y) * sat + warm;
      g = y + (g - y) * sat;
      b = y + (b - y) * sat - warm;
    }
    d[o] = r; d[o + 1] = g; d[o + 2] = b;
  }
  if (s.sharpness > 0) sharpen(img, (s.sharpness / 100) * 1.6, sharpScale > 1.8 ? 2 : 1);
  x.putImageData(img, 0, 0);
}

// Unsharp mask: each pixel pushed away from the average of its neighbours
// `step` pixels off.
function sharpen(img, amount, step) {
  const { width: w, height: hh, data: d } = img;
  const src = new Uint8ClampedArray(d);
  const row = w * 4 * step, col = 4 * step;
  for (let y = step; y < hh - step; y++) {
    for (let x = step, o = (y * w + step) * 4; x < w - step; x++, o += 4) {
      for (let k = 0; k < 3; k++) {
        const i = o + k;
        const blur = (src[i - row] + src[i + row] + src[i - col] + src[i + col]) / 4;
        d[i] = src[i] + amount * (src[i] - blur);
      }
    }
  }
}

const enhanceImage = {
  id: 'enhance-image', keywords: 'passport id card photo picture brightness contrast sharpen light dark shadow fix improve straighten crop rotate', title: 'Enhance image', icon: 'enhance', color: '#f59e0b', cat: 'edit',
  accept: 'image', wide: true, action: 'Save image', busyText: 'Saving…',
  desc: 'Make a passport or ID photo brighter, clearer and straight.',
  long: 'Fix a photo of a passport, ID card or document: brightness, contrast, shadows, sharpness, turn, straighten and crop. Save it as JPG, PNG or PDF.',
  setup(ctx) {
    const it = ctx.items[0];
    const s = ctx.state = { ...fresh(), format: 'jpg' };
    const stage = h('div', { class: 'crop__stage enh-stage' }, h('canvas'));
    const holder = h('div', { class: 'crop__holder enh-holder' }, stage);
    const msg = h('p', { class: 'muted small enh-hint' }, 'Drag the corners to crop. Hold “Compare” to see the original.');
    let small, base, comparing = false, queued = false;
    ctx.action.disabled = true;
    ctx.main.append(holder, msg);

    // base: the turned, straightened preview before colour changes.
    const rebuild = () => { base = place(small, s, PREVIEW, false); paint(); };
    const paint = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!base) return;
        const c = h('canvas', { width: base.width, height: base.height });
        c.getContext('2d').drawImage(base, 0, 0);
        if (!comparing) adjust(c, s);
        stage.querySelector('canvas').replaceWith(c);
      });
    };
    const box = cropper(stage, s.cut, (r) => (s.cut = r));

    const sliders = new Map();
    const sliderRow = ([key, label, min = -100, max = 100]) => {
      const out = h('output', {}, String(s[key]));
      const input = h('input', { type: 'range', min, max, step: 1, value: s[key], 'aria-label': label,
        oninput: (e) => { s[key] = +e.target.value; out.textContent = String(s[key]); paint(); } });
      sliders.set(key, { input, out });
      return field(label, h('div', { class: 'slider' }, input, out));
    };
    const autoBtn = h('button', { class: 'btn btn--soft btn--block enh-auto', type: 'button', onclick: () => {
      if (!small) return;
      const on = !autoBtn.classList.contains('on');
      s.levels = on ? (findLevels(base) || { lo: 0, hi: 255 }) : null;
      if (on && s.sharpness < 25) setSlider('sharpness', 25);
      autoBtn.classList.toggle('on', on);
      paint();
    } }, icon('enhance'), 'Auto fix');
    const setSlider = (key, v) => { s[key] = v; const x = sliders.get(key); if (x) { x.input.value = v; x.out.textContent = String(v); } };

    const angleOut = h('output', {}, '0°');
    const angle = h('input', { type: 'range', min: -15, max: 15, step: 0.5, value: 0, 'aria-label': 'Straighten',
      oninput: (e) => { s.angle = +e.target.value; angleOut.textContent = `${s.angle}°`; stage.classList.add('enh-grid'); rebuild(); },
      onchange: () => stage.classList.remove('enh-grid') });
    const turn = (by) => {
      s.rot = (s.rot + by + 360) % 360;
      s.cut = turnRect(s.cut, by);
      box.set(s.cut);
      rebuild();
    };
    const compare = h('button', { class: 'btn btn--ghost', type: 'button', title: 'Hold to see the original' }, icon('compare'), 'Compare');
    const hold = (on) => { if (comparing !== on) { comparing = on; paint(); } };
    compare.addEventListener('pointerdown', () => hold(true));
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) compare.addEventListener(ev, () => hold(false));
    const evenCheck = check('Even out shadows on paper', s.even, (v) => { s.even = v; paint(); });
    const grayCheck = check('Black and white', s.gray, (v) => { s.gray = v; paint(); });
    const reset = () => {
      Object.assign(s, fresh());
      for (const [key] of SLIDERS) setSlider(key, 0);
      angle.value = 0; angleOut.textContent = '0°';
      autoBtn.classList.remove('on');
      evenCheck.querySelector('input').checked = false;
      grayCheck.querySelector('input').checked = false;
      box.set(s.cut);
      rebuild();
    };

    ctx.side.append(
      autoBtn,
      ...SLIDERS.map(sliderRow),
      field('Straighten', h('div', { class: 'slider' }, angle, angleOut)),
      h('div', { class: 'enh-row' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => turn(-90), title: 'Turn left', 'aria-label': 'Turn left' }, icon('rotateLeft')),
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => turn(90), title: 'Turn right', 'aria-label': 'Turn right' }, icon('rotate')),
        compare),
      evenCheck, grayCheck,
      field('Save as', segmented([['jpg', 'JPG'], ['png', 'PNG'], ['pdf', 'PDF (A4)']], s.format, (v) => {
        s.format = v;
        ctx.action.firstChild.nodeValue = v === 'pdf' ? 'Save PDF' : 'Save image';
      })),
      h('button', { class: 'linkbtn', type: 'button', onclick: reset }, 'Reset everything'));

    decode(it.file, PREVIEW).then((bmp) => {
      if (!holder.isConnected) return;
      small = bmp;
      ctx.action.disabled = false;
      rebuild();
    }).catch(() => {
      msg.textContent = /\.(heic|heif)$/i.test(it.name) || /hei[cf]/i.test(it.file.type)
        ? `“${it.name}” is a HEIC photo, which this browser can’t open. Save it as JPG first (on iPhone: Settings › Camera › Formats › Most Compatible).`
        : `“${it.name}” can’t be read as an image.`;
      msg.classList.add('vid-bad');
    });
  },
  async run(ctx) {
    const it = ctx.items[0];
    const s = ctx.state;
    busy('Working on the full-size picture…');
    await tick();
    const full = await decode(it.file, MAX_OUT);
    const c = place(full, { ...s, cut: isFull(s.cut) ? FULL : s.cut }, MAX_OUT, true);
    const scale = Math.max(full.width, full.height) / PREVIEW;
    full.close?.();
    adjust(c, s, scale);
    const type = s.format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((r) => c.toBlob(r, type, 0.92));
    if (!blob) throw new Error('This picture is too large for this device. Try a smaller one.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const size = `${c.width} × ${c.height}`;
    const name = baseName(it.name) + '-enhanced';
    if (s.format !== 'pdf') {
      c.width = c.height = 0;
      return { files: [{ name: `${name}.${s.format}`, bytes, type }], title: 'Your image is ready', note: size };
    }
    // A4, turned to suit the picture, inside a small margin.
    const doc = await PDFDocument.create();
    const img = await doc.embedJpg(bytes);
    const [pw, ph] = c.width > c.height ? [A4[1], A4[0]] : A4;
    const m = 28, f = Math.min((pw - 2 * m) / c.width, (ph - 2 * m) / c.height, 0.75);
    const w = c.width * f, hh = c.height * f;
    c.width = c.height = 0;
    doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
    return { files: [pdfOut(`${name}.pdf`, await doc.save())], title: 'Your PDF is ready', note: `${size}, on an A4 page` };
  },
};

export const ENHANCE = [enhanceImage];
