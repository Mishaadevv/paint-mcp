import type { BlendMode, PaintStyle, Raster, Rgba } from "../types.js";
import { lerpColor, rgba } from "./color.js";

export const BLEND_MODES: BlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "dodge",
  "burn",
  "difference",
  "exclusion",
  "add",
  "subtract",
];

export function createRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneRaster(src: Raster): Raster {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

export function rasterFilled(width: number, height: number, color: Rgba): Raster {
  const out = createRaster(width, height);
  for (let i = 0; i < width * height; i++) {
    out.data[i * 4] = color.r;
    out.data[i * 4 + 1] = color.g;
    out.data[i * 4 + 2] = color.b;
    out.data[i * 4 + 3] = color.a;
  }
  return out;
}

export function indexOfPixel(img: Raster, x: number, y: number): number {
  return (y * img.width + x) * 4;
}

export function inBounds(img: Raster, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < img.width && y < img.height;
}

export function getPixel(img: Raster, x: number, y: number): Rgba {
  if (!inBounds(img, Math.floor(x), Math.floor(y))) return rgba(0, 0, 0, 0);
  const i = indexOfPixel(img, Math.floor(x), Math.floor(y));
  return rgba(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
}

export function setPixel(img: Raster, x: number, y: number, color: Rgba): void {
  if (!inBounds(img, x, y)) return;
  const i = indexOfPixel(img, x, y);
  img.data[i] = color.r;
  img.data[i + 1] = color.g;
  img.data[i + 2] = color.b;
  img.data[i + 3] = color.a;
}

/** Nearest sample point of a paint style at a pixel coordinate. */
export function styleAt(style: PaintStyle, x: number, y: number): Rgba {
  switch (style.kind) {
    case "solid":
      return style.color;
    case "linear": {
      const dx = style.x1 - style.x0;
      const dy = style.y1 - style.y0;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - style.x0) * dx + (y - style.y0) * dy) / len2));
      return sampleStops(style.stops, t);
    }
    case "radial": {
      const d = Math.hypot(x - style.cx, y - style.cy);
      return sampleStops(style.stops, Math.max(0, Math.min(1, d / (style.r || 1))));
    }
    case "pattern": {
      const tile = style.raster;
      const sx = Math.floor(x / style.scale) % tile.width;
      const sy = Math.floor(y / style.scale) % tile.height;
      const px = ((sx % tile.width) + tile.width) % tile.width;
      const py = ((sy % tile.height) + tile.height) % tile.height;
      return getPixel(tile, px, py);
    }
  }
}

export function sampleStops(stops: { at: number; color: Rgba }[], t: number): Rgba {
  if (stops.length === 0) return rgba(0, 0, 0, 0);
  const k = Math.max(0, Math.min(1, t));
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  if (k <= sorted[0].at) return sorted[0].color;
  const last = sorted[sorted.length - 1];
  if (k >= last.at) return last.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (k >= a.at && k <= b.at) {
      const span = b.at - a.at || 1;
      return lerpColor(a.color, b.color, (k - a.at) / span);
    }
  }
  return last.color;
}

function separable(mode: BlendMode, s: number, d: number): number {
  switch (mode) {
    case "multiply":
      return (s * d) / 255;
    case "screen":
      return 255 - ((255 - s) * (255 - d)) / 255;
    case "overlay":
      return d < 128 ? (2 * s * d) / 255 : 255 - (2 * (255 - s) * (255 - d)) / 255;
    case "darken":
      return Math.min(s, d);
    case "lighten":
      return Math.max(s, d);
    case "dodge":
      return s >= 255 ? 255 : Math.min(255, (d / (1 - s / 255)) | 0);
    case "burn":
      return s <= 0 ? 0 : Math.max(0, 255 - ((255 - d) / (s / 255) | 0));
    case "difference":
      return Math.abs(s - d);
    case "exclusion":
      return s + d - (2 * s * d) / 255;
    case "add":
      return Math.min(255, s + d);
    case "subtract":
      return Math.max(0, d - s);
    default:
      return s;
  }
}

/**
 * Write `color` onto `img` at (x, y) using source-over compositing.
 * `coverage` (0..1) is the sub-pixel area, `opacity` a global multiplier.
 */
export function paintPixel(
  img: Raster,
  x: number,
  y: number,
  color: Rgba,
  coverage = 1,
  opacity = 1,
  mode: BlendMode = "normal",
): void {
  if (!inBounds(img, x, y)) return;
  const alphaSrc = (color.a / 255) * Math.max(0, Math.min(1, coverage)) * Math.max(0, Math.min(1, opacity));
  if (alphaSrc <= 0.0001) return;
  const i = indexOfPixel(img, x, y);
  const dst = rgba(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
  if (mode === "normal") {
    const da = dst.a / 255;
    const oa = alphaSrc + da * (1 - alphaSrc);
    if (oa <= 0) {
      setPixel(img, x, y, rgba(0, 0, 0, 0));
      return;
    }
    const mix = (s: number, d: number): number => (s * alphaSrc + d * da * (1 - alphaSrc)) / oa;
    setPixel(img, x, y, rgba(mix(color.r, dst.r), mix(color.g, dst.g), mix(color.b, dst.b), oa * 255));
    return;
  }
  const da = dst.a / 255;
  const oa = alphaSrc + da * (1 - alphaSrc);
  if (oa <= 0) return;
  const channel = (s: number, d: number): number => {
    const blended = separable(mode, s, d);
    return (alphaSrc * (1 - da) * s + alphaSrc * da * blended + da * (1 - alphaSrc) * d) / oa;
  };
  setPixel(img, x, y, rgba(channel(color.r, dst.r), channel(color.g, dst.g), channel(color.b, dst.b), oa * 255));
}

export interface CompositeOptions {
  x?: number;
  y?: number;
  opacity?: number;
  blend?: BlendMode;
  /** Clip: only this destination rect is written. */
  clip?: { x: number; y: number; width: number; height: number };
  /** Rescale the source before compositing. */
  scale?: number;
  /** Rotate the source around its centre (degrees). */
  rotate?: number;
}

/** Composite `src` onto `dst` at an offset, honouring alpha, opacity and blend mode. */
export function composite(
  dst: Raster,
  src: Raster,
  options: CompositeOptions = {},
): { x: number; y: number; width: number; height: number } {
  const opacity = options.opacity ?? 1;
  const blend = options.blend ?? "normal";
  const scale = options.scale ?? 1;
  const ox = Math.round(options.x ?? 0);
  const oy = Math.round(options.y ?? 0);
  const rotated = options.rotate ? rotateRasterBilinear(src, options.rotate, true) : src;
  const w = Math.max(1, Math.round(rotated.width * scale));
  const h = Math.max(1, Math.round(rotated.height * scale));

  const clip = options.clip ?? { x: 0, y: 0, width: dst.width, height: dst.height };
  for (let y = 0; y < h; y++) {
    const dy = oy + y;
    if (dy < clip.y || dy >= clip.y + clip.height || dy >= dst.height) continue;
    for (let x = 0; x < w; x++) {
      const dxp = ox + x;
      if (dxp < clip.x || dxp >= clip.x + clip.width || dxp >= dst.width) continue;
      const sx = Math.min(rotated.width - 1, Math.floor((x / w) * rotated.width));
      const sy = Math.min(rotated.height - 1, Math.floor((y / h) * rotated.height));
      const si = indexOfPixel(rotated, sx, sy);
      if (rotated.data[si + 3] === 0) continue;
      paintPixel(
        dst,
        dxp,
        dy,
        rgba(rotated.data[si], rotated.data[si + 1], rotated.data[si + 2], rotated.data[si + 3]),
        1,
        opacity,
        blend,
      );
    }
  }
  return { x: ox, y: oy, width: w, height: h };
}

function sampleBilinear(img: Raster, x: number, y: number, expandEdge = true): Rgba {
  const clamped = (v: number, max: number): number =>
    expandEdge ? Math.max(-0.5, Math.min(max - 0.5, v)) : Math.max(0, Math.min(max - 1, v));
  const fx = clamped(x, img.width);
  const fy = clamped(y, img.height);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (px: number, py: number): Rgba => {
    const i = indexOfPixel(img, px, py);
    return rgba(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
  };
  const tl = at(x0, y0);
  const tr = at(x1, y0);
  const bl = at(x0, y1);
  const br = at(x1, y1);
  const top = lerpColor(tl, tr, tx);
  const bottom = lerpColor(bl, br, tx);
  return lerpColor(top, bottom, ty);
}

/** Bilinear rescale; `expandEdge` keeps borders from fading into transparency. */
export function resizeRaster(img: Raster, width: number, height: number, smooth = true): Raster {
  const out = createRaster(Math.max(1, width), Math.max(1, height));
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      if (smooth) {
        const c = sampleBilinear(img, (x + 0.5) * (img.width / out.width) - 0.5, (y + 0.5) * (img.height / out.height) - 0.5);
        setPixel(out, x, y, c);
      } else {
        const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / out.width));
        const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / out.height));
        setPixel(out, x, y, getPixel(img, sx, sy));
      }
    }
  }
  return out;
}

/** Rotate around the centre; canvas grows to fit unless `keepSize`. */
export function rotateRasterBilinear(img: Raster, degrees: number, expand = true): Raster {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cw = img.width / 2;
  const ch = img.height / 2;
  let outW = img.width;
  let outH = img.height;
  if (expand) {
    outW = Math.ceil(Math.abs(img.width * cos) + Math.abs(img.height * sin));
    outH = Math.ceil(Math.abs(img.width * sin) + Math.abs(img.height * cos));
  }
  const out = createRaster(Math.max(1, outW), Math.max(1, outH));
  const ocx = out.width / 2;
  const ocy = out.height / 2;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const dx = x - ocx;
      const dy = y - ocy;
      const sx = cw + dx * cos + dy * sin;
      const sy = ch - dx * sin + dy * cos;
      if (sx < -1 || sy < -1 || sx > img.width || sy > img.height) continue;
      setPixel(out, x, y, sampleBilinear(img, sx, sy));
    }
  }
  return out;
}

export function flipRaster(img: Raster, axis: "horizontal" | "vertical" | "both"): Raster {
  const out = createRaster(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = axis === "horizontal" || axis === "both" ? img.width - 1 - x : x;
      const sy = axis === "vertical" || axis === "both" ? img.height - 1 - y : y;
      setPixel(out, x, y, getPixel(img, sx, sy));
    }
  }
  return out;
}

export function cropRaster(img: Raster, x: number, y: number, width: number, height: number): Raster {
  const out = createRaster(width, height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      setPixel(out, i, j, getPixel(img, x + i, y + j));
    }
  }
  return out;
}

/** Pad/crop the canvas to a new size, keeping the content anchored. */
export function padRaster(
  img: Raster,
  width: number,
  height: number,
  anchor: "center" | "top-left" | "top" | "top-right" | "left" | "right" | "bottom-left" | "bottom" | "bottom-right" = "center",
): Raster {
  const out = createRaster(width, height);
  const ox = anchor.includes("left")
    ? 0
    : anchor.includes("right")
      ? width - img.width
      : Math.round((width - img.width) / 2);
  const oy = anchor.includes("top")
    ? 0
    : anchor.includes("bottom")
      ? height - img.height
      : Math.round((height - img.height) / 2);
  composite(out, img, { x: ox, y: oy });
  return out;
}

/** Bounding box of non-transparent pixels; null when the layer is empty. */
export function alphaBounds(
  img: Raster,
  minAlpha = 1,
): { x: number; y: number; width: number; height: number } | null {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[indexOfPixel(img, x, y) + 3] >= minAlpha) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export interface PixelStats {
  opaque_pixels: number;
  transparent_pixels: number;
  mean: Rgba;
  bounds: { x: number; y: number; width: number; height: number } | null;
  dominant: { hex: string; count: number; share: number }[];
}

/** Quantised colour statistics — the agent's eyes when a preview is too small. */
export function rasterStats(img: Raster, top = 6): PixelStats {
  const buckets = new Map<number, number>();
  let opaque = 0;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let aSum = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3];
    if (a === 0) continue;
    opaque++;
    const r = img.data[i * 4];
    const g = img.data[i * 4 + 1];
    const b = img.data[i * 4 + 2];
    rSum += r;
    gSum += g;
    bSum += b;
    aSum += a;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const dominant = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([key, count]) => {
      const r = ((key >> 8) & 15) * 16 + 8;
      const g = ((key >> 4) & 15) * 16 + 8;
      const b = (key & 15) * 16 + 8;
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      return { hex, count, share: opaque ? Math.round((count / opaque) * 1000) / 1000 : 0 };
    });
  return {
    opaque_pixels: opaque,
    transparent_pixels: img.width * img.height - opaque,
    mean: opaque ? rgba(rSum / opaque, gSum / opaque, bSum / opaque, aSum / opaque) : rgba(0, 0, 0, 0),
    bounds: alphaBounds(img),
    dominant,
  };
}
