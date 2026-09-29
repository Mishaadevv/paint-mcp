import type { Raster } from "../types.js";
import { cloneRaster, createRaster, indexOfPixel } from "./image.js";

export type FilterName =
  | "blur"
  | "sharpen"
  | "edge_detect"
  | "brightness"
  | "contrast"
  | "gamma"
  | "saturation"
  | "hue_rotate"
  | "grayscale"
  | "sepia"
  | "invert"
  | "threshold"
  | "posterize"
  | "pixelate"
  | "noise"
  | "vignette"
  | "chroma_shift"
  | "dither";

export const FILTER_NAMES: FilterName[] = [
  "blur",
  "sharpen",
  "edge_detect",
  "brightness",
  "contrast",
  "gamma",
  "saturation",
  "hue_rotate",
  "grayscale",
  "sepia",
  "invert",
  "threshold",
  "posterize",
  "pixelate",
  "noise",
  "vignette",
  "chroma_shift",
  "dither",
];

export interface FilterParams {
  /** Radius / amount / degrees, depending on the filter. */
  amount?: number;
  /** Extra control (posterize levels, noise strength, shift direction). */
  level?: number;
  angle?: number;
  seed?: number;
}

type Rect = { x: number; y: number; width: number; height: number };

const full = (img: Raster): Rect => ({ x: 0, y: 0, width: img.width, height: img.height });

function intersect(rect: Rect, img: Raster): Rect {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(0, x1 - x), height: Math.max(0, y1 - y) };
}

function separableBlur(img: Raster, radius: number, area: Rect, passes = 3): void {
  if (radius < 1) return;
  let source = cloneRaster(img);
  const r = Math.max(1, Math.round(radius));
  for (let pass = 0; pass < passes; pass++) {
    const next = createRaster(img.width, img.height);
    next.data.set(img.data);
    // horizontal
    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sa = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const sx = Math.max(0, Math.min(img.width - 1, x + k));
          const i = indexOfPixel(source, sx, y);
          const w = r + 1 - Math.abs(k);
          sr += source.data[i] * w;
          sg += source.data[i + 1] * w;
          sb += source.data[i + 2] * w;
          sa += source.data[i + 3] * w;
          n += w;
        }
        const i = indexOfPixel(next, x, y);
        next.data[i] = sr / n;
        next.data[i + 1] = sg / n;
        next.data[i + 2] = sb / n;
        next.data[i + 3] = sa / n;
      }
    }
    // vertical
    const after = createRaster(img.width, img.height);
    after.data.set(next.data);
    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sa = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const sy = Math.max(0, Math.min(img.height - 1, y + k));
          const i = indexOfPixel(next, x, sy);
          const w = r + 1 - Math.abs(k);
          sr += next.data[i] * w;
          sg += next.data[i + 1] * w;
          sb += next.data[i + 2] * w;
          sa += next.data[i + 3] * w;
          n += w;
        }
        const i = indexOfPixel(after, x, y);
        after.data[i] = sr / n;
        after.data[i + 1] = sg / n;
        after.data[i + 2] = sb / n;
        after.data[i + 3] = sa / n;
      }
    }
    source = after;
  }
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const i = indexOfPixel(source, x, y);
      const j = indexOfPixel(img, x, y);
      img.data[j] = source.data[i];
      img.data[j + 1] = source.data[i + 1];
      img.data[j + 2] = source.data[i + 2];
      img.data[j + 3] = source.data[i + 3];
    }
  }
}

function mapPixels(img: Raster, area: Rect, fn: (r: number, g: number, b: number, a: number) => [number, number, number]): void {
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const i = indexOfPixel(img, x, y);
      const [r, g, b] = fn(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
    }
  }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
    else if (max === gg) h = ((bb - rr) / d + 2) / 6;
    else h = ((rr - gg) / d + 4) / 6;
  }
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place image filter over an optional area. */
export function applyFilter(img: Raster, name: FilterName, params: FilterParams = {}, area?: Rect): void {
  const region = intersect(area ?? full(img), img);
  if (region.width <= 0 || region.height <= 0) return;
  const amount = params.amount ?? defaultAmount(name);

  switch (name) {
    case "blur":
      separableBlur(img, amount, region, params.level ? Math.max(1, Math.min(5, params.level)) : 3);
      return;
    case "sharpen": {
      const before = cloneRaster(img);
      separableBlur(img, Math.max(1, Math.round(amount / 3)), region, 1);
      const k = Math.max(0, amount) / 100;
      for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
          const i = indexOfPixel(img, x, y);
          const j = indexOfPixel(before, x, y);
          for (let c = 0; c < 3; c++) {
            img.data[i + c] = before.data[j + c] + k * (before.data[j + c] - img.data[i + c]);
          }
          img.data[i + 3] = before.data[j + 3];
        }
      }
      return;
    }
    case "edge_detect": {
      const before = cloneRaster(img);
      const sobel = (target: Raster): void => {
        for (let y = region.y; y < region.y + region.height; y++) {
          for (let x = region.x; x < region.x + region.width; x++) {
            const at = (dx: number, dy: number): number => {
              const sx = Math.max(0, Math.min(img.width - 1, x + dx));
              const sy = Math.max(0, Math.min(img.height - 1, y + dy));
              const i = indexOfPixel(before, sx, sy);
              return (before.data[i] + before.data[i + 1] + before.data[i + 2]) / 3;
            };
            const gx = -at(-1, -1) - 2 * at(-1, 0) - at(-1, 1) + at(1, -1) + 2 * at(1, 0) + at(1, 1);
            const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
            const v = Math.min(255, Math.hypot(gx, gy) * (amount / 100));
            const i = indexOfPixel(target, x, y);
            target.data[i] = v;
            target.data[i + 1] = v;
            target.data[i + 2] = v;
            target.data[i + 3] = before.data[i + 3] > 0 ? 255 : 0;
          }
        }
      };
      sobel(img);
      return;
    }
    case "brightness":
      mapPixels(img, region, (r, g, b) => [r + amount, g + amount, b + amount]);
      return;
    case "contrast": {
      const f = (101 * amount) / (100 * (101 - amount));
      mapPixels(img, region, (r, g, b) => [
        f * (r - 128) + 128,
        f * (g - 128) + 128,
        f * (b - 128) + 128,
      ]);
      return;
    }
    case "gamma": {
      const gamma = Math.max(0.1, amount);
      mapPixels(img, region, (r, g, b) => [
        255 * (r / 255) ** (1 / gamma),
        255 * (g / 255) ** (1 / gamma),
        255 * (b / 255) ** (1 / gamma),
      ]);
      return;
    }
    case "saturation":
      mapPixels(img, region, (r, g, b) => {
        const [h, s, l] = rgbToHsl(r, g, b);
        return hslToRgb(h, Math.max(0, Math.min(1, s * amount)), l);
      });
      return;
    case "hue_rotate": {
      const shift = amount / 360;
      mapPixels(img, region, (r, g, b) => {
        const [h, s, l] = rgbToHsl(r, g, b);
        return hslToRgb((h + shift) % 1, s, l);
      });
      return;
    }
    case "grayscale":
      mapPixels(img, region, (r, g, b) => {
        const v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return [v, v, v];
      });
      return;
    case "sepia":
      mapPixels(img, region, (r, g, b) => [
        Math.min(255, 0.393 * r + 0.769 * g + 0.189 * b),
        Math.min(255, 0.349 * r + 0.686 * g + 0.168 * b),
        Math.min(255, 0.272 * r + 0.534 * g + 0.131 * b),
      ]);
      return;
    case "invert":
      mapPixels(img, region, (r, g, b) => [255 - r, 255 - g, 255 - b]);
      return;
    case "threshold":
      mapPixels(img, region, (r, g, b) => {
        const v = 0.299 * r + 0.587 * g + 0.114 * b >= amount ? 255 : 0;
        return [v, v, v];
      });
      return;
    case "posterize": {
      const levels = Math.max(2, Math.round(amount));
      const step = 255 / (levels - 1);
      mapPixels(img, region, (r, g, b) => [
        Math.round(Math.round(r / step) * step),
        Math.round(Math.round(g / step) * step),
        Math.round(Math.round(b / step) * step),
      ]);
      return;
    }
    case "pixelate": {
      const block = Math.max(1, Math.round(amount));
      for (let y = region.y; y < region.y + region.height; y += block) {
        for (let x = region.x; x < region.x + region.width; x += block) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          let n = 0;
          for (let dy = 0; dy < block && y + dy < region.y + region.height; dy++) {
            for (let dx = 0; dx < block && x + dx < region.x + region.width; dx++) {
              const i = indexOfPixel(img, x + dx, y + dy);
              r += img.data[i];
              g += img.data[i + 1];
              b += img.data[i + 2];
              a += img.data[i + 3];
              n++;
            }
          }
          for (let dy = 0; dy < block && y + dy < region.y + region.height; dy++) {
            for (let dx = 0; dx < block && x + dx < region.x + region.width; dx++) {
              const i = indexOfPixel(img, x + dx, y + dy);
              img.data[i] = r / n;
              img.data[i + 1] = g / n;
              img.data[i + 2] = b / n;
              img.data[i + 3] = a / n;
            }
          }
        }
      }
      return;
    }
    case "noise": {
      const rnd = mulberry32(params.seed ?? 7);
      mapPixels(img, region, (r, g, b) => {
        const jitter = (rnd() - 0.5) * amount * 2;
        return [r + jitter, g + jitter, b + jitter];
      });
      return;
    }
    case "vignette": {
      const cx = region.x + region.width / 2;
      const cy = region.y + region.height / 2;
      const reach = Math.hypot(region.width, region.height) / 2;
      for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
          const d = Math.hypot(x - cx, y - cy) / reach;
          const factor = Math.max(0, 1 - d ** 2 * (amount / 100));
          const i = indexOfPixel(img, x, y);
          img.data[i] *= factor;
          img.data[i + 1] *= factor;
          img.data[i + 2] *= factor;
        }
      }
      return;
    }
    case "chroma_shift": {
      const before = cloneRaster(img);
      const dx = Math.round(amount);
      const dy = Math.round(params.angle === 90 ? amount : 0);
      for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
          const i = indexOfPixel(img, x, y);
          const sx = Math.max(0, Math.min(img.width - 1, x - dx));
          const sy = Math.max(0, Math.min(img.height - 1, y - dy));
          const src = indexOfPixel(before, sx, sy);
          img.data[i] = before.data[src];
          img.data[i + 2] = before.data[src + 2];
        }
      }
      return;
    }
    case "dither": {
      // Floyd–Steinberg to `level` grey values
      const levels = Math.max(2, Math.round(params.level ?? 2));
      const step = 255 / (levels - 1);
      const work = createRaster(img.width, img.height);
      work.data.set(img.data);
      const lum = new Float32Array(img.width * img.height);
      for (let i = 0; i < img.width * img.height; i++) {
        lum[i] = (0.299 * work.data[i * 4] + 0.587 * work.data[i * 4 + 1] + 0.114 * work.data[i * 4 + 2]) / 255;
      }
      const quantize = (value: number): number => Math.round(Math.round(value * 255 / step) * step);
      for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
          const idx = y * img.width + x;
          const old = lum[idx] * 255;
          const value = quantize(old / 255);
          const error = old - value;
          lum[idx] = value / 255;
          const spread = (dx: number, dy: number, weight: number): void => {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < region.x || ny < region.y || nx >= region.x + region.width || ny >= region.y + region.height) return;
            const nIdx = ny * img.width + nx;
            lum[nIdx] = Math.max(0, Math.min(1, lum[nIdx] + (error * weight) / 255));
          };
          spread(1, 0, 7 / 16);
          spread(-1, 1, 3 / 16);
          spread(0, 1, 5 / 16);
          spread(1, 1, 1 / 16);
        }
      }
      for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
          const i = indexOfPixel(img, x, y);
          const v = lum[y * img.width + x] * 255;
          const ratio = work.data[i + 3] === 0 ? 0 : 1;
          img.data[i] = v * ratio;
          img.data[i + 1] = v * ratio;
          img.data[i + 2] = v * ratio;
        }
      }
      return;
    }
  }
}

export function defaultAmount(name: FilterName): number {
  switch (name) {
    case "blur":
      return 3;
    case "sharpen":
      return 120;
    case "edge_detect":
      return 100;
    case "brightness":
      return 20;
    case "contrast":
      return 30;
    case "gamma":
      return 1.4;
    case "saturation":
      return 1.5;
    case "hue_rotate":
      return 60;
    case "threshold":
      return 128;
    case "posterize":
      return 4;
    case "pixelate":
      return 8;
    case "noise":
      return 30;
    case "vignette":
      return 60;
    case "chroma_shift":
      return 3;
    default:
      return 1;
  }
}
