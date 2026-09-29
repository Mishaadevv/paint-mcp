import type { BlendMode, Bounds, CapStyle, PaintStyle, PathShape, Raster, Rgba, Subpath } from "../types.js";
import { colorDistance, parseColor } from "./color.js";
import { composite, createRaster, getPixel, inBounds, paintPixel, setPixel, styleAt } from "./image.js";

export interface DrawOptions {
  /** 0..1 global strength of this operation. */
  opacity?: number;
  blend?: BlendMode;
  /** Restrict the write to a rectangle. */
  clip?: Bounds;
}

export function boundsOf(path: PathShape): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const sub of path.subpaths) {
    for (const [x, y] of sub) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Semi-transparent or blended geometry is rendered into a scratch tile first and
 * composited once, so overlapping spans of the same shape never double-darken.
 */
function paintTile(target: Raster, bounds: Bounds, options: DrawOptions, draw: (tile: Raster, ox: number, oy: number) => void): Bounds {
  const x0 = Math.max(0, Math.floor(bounds.x));
  const y0 = Math.max(0, Math.floor(bounds.y));
  const x1 = Math.min(target.width, Math.ceil(bounds.x + bounds.width) + 1);
  const y1 = Math.min(target.height, Math.ceil(bounds.y + bounds.height) + 1);
  const area = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  if (area.width <= 0 || area.height <= 0) return area;
  const opacity = options.opacity ?? 1;
  const needsTile = opacity < 1 || (options.blend ?? "normal") !== "normal" || options.clip !== undefined;
  if (!needsTile) {
    draw(target, 0, 0);
    return area;
  }
  const tile = createRaster(area.width, area.height);
  draw(tile, -x0, -y0);
  composite(target, tile, {
    x: x0,
    y: y0,
    opacity,
    blend: options.blend,
    clip: options.clip ?? { x: 0, y: 0, width: target.width, height: target.height },
  });
  return area;
}

function edgeTable(path: PathShape): number[][] {
  const edges: number[][] = [];
  for (const sub of path.subpaths) {
    const limit = path.closed ? sub.length : sub.length - 1;
    for (let i = 0; i < limit; i++) {
      const a = sub[i];
      const b = sub[(i + 1) % sub.length];
      if (a[1] === b[1]) continue;
      edges.push([a[0], a[1], b[0], b[1], a[1] < b[1] ? 1 : -1]);
    }
  }
  return edges;
}

/** Accumulate sub-pixel coverage for one pixel row into `coverage`. */
function rowCoverage(
  edges: number[][],
  y: number,
  width: number,
  coverage: Float32Array,
  evenOdd: boolean,
  subRows: number,
): boolean {
  let any = false;
  for (let s = 0; s < subRows; s++) {
    const sy = y + (s + 0.5) / subRows;
    const events: { x: number; dir: number }[] = [];
    for (const [x0, y0, x1, y1, dir] of edges) {
      const lo = Math.min(y0, y1);
      const hi = Math.max(y0, y1);
      if (sy < lo || sy >= hi) continue;
      events.push({ x: x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), dir });
    }
    events.sort((a, b) => a.x - b.x);
    const spans: number[] = [];
    if (evenOdd) {
      for (let i = 0; i + 1 < events.length; i += 2) spans.push(events[i].x, events[i + 1].x);
    } else {
      let winding = 0;
      for (const ev of events) {
        const before = winding;
        winding += ev.dir;
        if ((before === 0) !== (winding === 0)) spans.push(ev.x);
      }
    }
    for (let i = 0; i + 1 < spans.length; i += 2) {
      const a = spans[i];
      const b = spans[i + 1];
      if (b <= a) continue;
      const px0 = Math.max(0, Math.floor(a));
      const px1 = Math.min(width - 1, Math.ceil(b) - 1);
      for (let px = px0; px <= px1; px++) {
        const cov = (Math.min(b, px + 1) - Math.max(a, px)) / subRows;
        if (cov > 0) {
          coverage[px] += cov;
          any = true;
        }
      }
    }
  }
  return any;
}

export interface FillOptions extends DrawOptions {
  /** Even-odd rule instead of non-zero winding (SVG default is non-zero). */
  evenOdd?: boolean;
  /** Sub-rows sampled per pixel line: 1 = hard edges, 3 = default, 5 = very smooth. */
  samples?: number;
}

/** Anti-aliased scanline fill of a path with any paint style. */
export function fillPath(target: Raster, path: PathShape, style: PaintStyle, options: FillOptions = {}): Bounds {
  const edges = edgeTable(path);
  if (edges.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const bounds = boundsOf(path);
  const evenOdd = options.evenOdd ?? false;
  const subRows = Math.max(1, Math.min(7, Math.round(options.samples ?? 3)));
  return paintTile(target, bounds, options, (tile, ox, oy) => {
    const coverage = new Float32Array(tile.width);
    const yStart = Math.max(0, Math.floor(bounds.y + oy));
    const yEnd = Math.min(tile.height - 1, Math.ceil(bounds.y + bounds.height + oy));
    for (let y = yStart; y <= yEnd; y++) {
      if (!rowCoverage(edges, y + oy, tile.width, coverage, evenOdd, subRows)) {
        coverage.fill(0);
        continue;
      }
      for (let x = 0; x < tile.width; x++) {
        const cov = coverage[x];
        if (cov <= 0.002) continue;
        paintPixel(tile, x, y, styleAt(style, x + ox, y + oy), Math.min(1, cov), 1, "normal");
      }
      coverage.fill(0);
    }
  });
}

function softEdge(value: number): number {
  return Math.max(0, Math.min(1, value + 0.5));
}

export interface StrokeOptions extends DrawOptions {
  width?: number;
  cap?: CapStyle;
  dashes?: number[];
  dashOffset?: number;
  /** Per-point widths (tapered strokes); overrides `width` when supplied. */
  widths?: number[];
  /** 0..1 — 1 is a hard crayon edge, low values fade out like an airbrush. */
  hardness?: number;
}

/**
 * Strokes by measuring per-pixel distance to each segment capsule: joins and
 * round caps come out anti-aliased without extra geometry.
 */
export function strokePath(target: Raster, path: PathShape, style: PaintStyle, options: StrokeOptions = {}): Bounds {
  const width = Math.max(0.05, options.width ?? 1);
  const runs =
    options.dashes && options.dashes.length > 0
      ? path.subpaths.flatMap((sub) => dashRuns(sub, options.dashes as number[], options.dashOffset ?? 0))
      : path.subpaths;
  const drawn = runs.filter((sub) => sub.length >= 2);
  if (drawn.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const maxHalf =
    (options.widths && options.widths.length > 0 ? Math.max(width, ...options.widths) : width) / 2;
  const flat = drawn.flat();
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  const bounds: Bounds = {
    x: Math.min(...xs) - maxHalf * 2,
    y: Math.min(...ys) - maxHalf * 2,
    width: Math.max(...xs) - Math.min(...xs) + maxHalf * 4,
    height: Math.max(...ys) - Math.min(...ys) + maxHalf * 4,
  };

  return paintTile(target, bounds, options, (tile, ox, oy) => {
    for (const sub of drawn) {
      const last = sub.length - 1;
      for (let i = 0; i < last; i++) {
        const [ax, ay] = sub[i];
        const [bx, by] = sub[i + 1];
        const wA = options.widths ? options.widths[Math.min(i, options.widths.length - 1)] : width;
        const wB = options.widths ? options.widths[Math.min(i + 1, options.widths.length - 1)] : width;
        strokeSegment(tile, ax, ay, bx, by, wA, wB, style, options.cap ?? "round", options.hardness ?? 1, ox, oy);
      }
      const closedSub = path.closed && Math.hypot(sub[0][0] - sub[last][0], sub[0][1] - sub[last][1]) < 0.01;
      if ((options.cap ?? "round") === "round" && !closedSub) {
        for (const point of [sub[0], sub[last]]) {
          const w = options.widths
            ? point === sub[0]
              ? options.widths[0]
              : options.widths[options.widths.length - 1]
            : width;
          strokeDisc(tile, point[0], point[1], w / 2, style, options.hardness ?? 1, ox, oy);
        }
      }
    }
  });
}

function strokeSegment(
  tile: Raster,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  wA: number,
  wB: number,
  style: PaintStyle,
  cap: CapStyle,
  hardness: number,
  ox: number,
  oy: number,
): void {
  const halfA = wA / 2;
  const halfB = wB / 2;
  const maxHalf = Math.max(halfA, halfB);
  const extend = cap === "square" ? maxHalf : 0;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const sx = ax - ux * extend;
  const sy = ay - uy * extend;
  const tx = bx + ux * extend;
  const ty = by + uy * extend;
  const reach = maxHalf + extend + 1;
  const px0 = Math.max(0, Math.floor(Math.min(sx, tx) - reach) - ox);
  const px1 = Math.min(tile.width - 1, Math.ceil(Math.max(sx, tx) + reach) - ox);
  const py0 = Math.max(0, Math.floor(Math.min(sy, ty) - reach) - oy);
  const py1 = Math.min(tile.height - 1, Math.ceil(Math.max(sy, ty) + reach) - oy);
  if (px1 < px0 || py1 < py0) return;
  const edge = Math.max(0.6, maxHalf * (1 - Math.max(0, Math.min(1, hardness))));
  for (let py = py0; py <= py1; py++) {
    const worldY = py + oy;
    for (let px = px0; px <= px1; px++) {
      const worldX = px + ox;
      const along = (worldX - sx) * ux + (worldY - sy) * uy;
      const span = Math.hypot(tx - sx, ty - sy);
      const t = span === 0 ? 0 : Math.max(0, Math.min(1, along / span));
      const half = halfA + (halfB - halfA) * t;
      let cov: number;
      if (cap === "butt") {
        const perp = Math.abs((worldX - ax) * uy - (worldY - ay) * ux);
        cov = Math.min(softEdge(half - perp), softEdge(along + 0.5), softEdge(len - along + 0.5));
      } else {
        const projX = sx + ux * along;
        const projY = sy + uy * along;
        const dist = Math.hypot(worldX - projX, worldY - projY);
        cov = softEdge((half - dist) / edge);
      }
      if (cov <= 0.002) continue;
      paintPixel(tile, px, py, styleAt(style, worldX, worldY), Math.min(1, cov), 1, "normal");
    }
  }
}

function strokeDisc(
  tile: Raster,
  cx: number,
  cy: number,
  radius: number,
  style: PaintStyle,
  hardness: number,
  ox: number,
  oy: number,
): void {
  const edge = Math.max(0.6, radius * (1 - Math.max(0, Math.min(1, hardness))));
  const px0 = Math.max(0, Math.floor(cx - radius - 1) - ox);
  const px1 = Math.min(tile.width - 1, Math.ceil(cx + radius + 1) - ox);
  const py0 = Math.max(0, Math.floor(cy - radius - 1) - oy);
  const py1 = Math.min(tile.height - 1, Math.ceil(cy + radius + 1) - oy);
  for (let py = py0; py <= py1; py++) {
    for (let px = px0; px <= px1; px++) {
      const dist = Math.hypot(px + ox - cx, py + oy - cy);
      const cov = softEdge((radius - dist) / edge);
      if (cov <= 0.002) continue;
      paintPixel(tile, px, py, styleAt(style, px + ox, py + oy), Math.min(1, cov), 1, "normal");
    }
  }
}

export interface BrushOptions extends DrawOptions {
  /** Stamp diameter in pixels. */
  size: number;
  hardness?: number;
  /** Gap between stamps as a fraction of size (0.1 = dense, 0.6 = spotty). */
  spacing?: number;
  /** 0..1 random offset perpendicular to the stroke, for a hand-drawn feel. */
  jitter?: number;
  /** Ellipse squash 0..0.95 (use with `angle` for calligraphy nibs). */
  flatten?: number;
  angle?: number;
  seed?: number;
}

/** Freehand brush: soft elliptical stamps sampled along the polyline. */
export function brushStroke(target: Raster, points: Subpath, style: PaintStyle, options: BrushOptions): Bounds {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const size = Math.max(0.5, options.size);
  const hardness = Math.max(0, Math.min(1, options.hardness ?? 0.85));
  const spacing = Math.max(0.4, (options.spacing ?? 0.18) * size);
  const jitter = options.jitter ?? 0;
  const flatten = Math.max(0, Math.min(0.95, options.flatten ?? 0));
  const angle = ((options.angle ?? 0) * Math.PI) / 180;
  const rnd = mulberry32(options.seed ?? 1);
  const bounds = boundsOf({ subpaths: [points], closed: false });
  return paintTile(
    target,
    { x: bounds.x - size, y: bounds.y - size, width: bounds.width + size * 2, height: bounds.height + size * 2 },
    options,
    (tile, ox, oy) => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const stamp = (x: number, y: number, w: number, h: number): void => {
        const radiusX = Math.max(0.25, w / 2);
        const radiusY = Math.max(0.25, h / 2);
        const reach = Math.max(radiusX, radiusY);
        const edge = Math.max(0.5, reach * (1 - hardness));
        const px0 = Math.max(0, Math.floor(x - reach - 1) - ox);
        const px1 = Math.min(tile.width - 1, Math.ceil(x + reach + 1) - ox);
        const py0 = Math.max(0, Math.floor(y - reach - 1) - oy);
        const py1 = Math.min(tile.height - 1, Math.ceil(y + reach + 1) - oy);
        for (let py = py0; py <= py1; py++) {
          const dy = py + oy - y;
          for (let px = px0; px <= px1; px++) {
            const dx = px + ox - x;
            const rx = dx * cos + dy * sin;
            const ry = -dx * sin + dy * cos;
            const normalised = Math.hypot(rx / radiusX, ry / radiusY);
            if (normalised >= 1) continue;
            const cov = softEdge(((1 - normalised) * radiusX) / edge);
            if (cov <= 0.002) continue;
            paintPixel(tile, px, py, styleAt(style, px + ox, py + oy), Math.min(1, cov), 1, "normal");
          }
        }
      };
      if (points.length === 1) {
        stamp(points[0][0], points[0][1], size, size * (1 - flatten));
        return;
      }
      for (let i = 0; i < points.length - 1; i++) {
        const [ax, ay, waRaw] = points[i];
        const [bx, by, wbRaw] = points[i + 1];
        const wa = waRaw ?? 1;
        const wb = wbRaw ?? 1;
        const len = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(len / spacing));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const wobX = jitter ? (rnd() - 0.5) * jitter * size : 0;
          const wobY = jitter ? (rnd() - 0.5) * jitter * size : 0;
          const w = size * (wa + (wb - wa) * t);
          stamp(ax + (bx - ax) * t + wobX, ay + (by - ay) * t + wobY, w, w * (1 - flatten));
        }
      }
      const end = points[points.length - 1];
      const lastW = size * (end[2] ?? 1);
      stamp(end[0], end[1], lastW, lastW * (1 - flatten));
    },
  );
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

/** Split a polyline into dash runs; a pattern longer than the line keeps the line. */
function dashRuns(points: Subpath, dashes: number[], offset: number): Subpath[] {
  const runs: Subpath[] = [];
  const cycle = dashes.reduce((a, b) => a + b, 0) || 1;
  let index = 0;
  let drawing = true;
  let remaining = Math.max(0.001, dashes[0]);
  let skip = ((offset % cycle) + cycle) % cycle;
  while (skip > 0) {
    const consumed = Math.min(skip, remaining);
    remaining -= consumed;
    skip -= consumed;
    if (remaining <= 0.0001) {
      index = (index + 1) % dashes.length;
      remaining = Math.max(0.001, dashes[index]);
      drawing = !drawing;
    }
  }
  let current: Subpath = [];
  for (let i = 0; i < points.length - 1; i++) {
    let ax = points[i][0];
    let ay = points[i][1];
    const bx = points[i + 1][0];
    const by = points[i + 1][1];
    if (drawing) current.push([ax, ay]);
    let left = Math.hypot(bx - ax, by - ay);
    const ux = left === 0 ? 0 : (bx - ax) / left;
    const uy = left === 0 ? 0 : (by - ay) / left;
    while (left > 0) {
      if (remaining <= left) {
        const nx = ax + ux * remaining;
        const ny = ay + uy * remaining;
        if (drawing) {
          current.push([nx, ny]);
          if (current.length > 1) runs.push(current);
          current = [];
        }
        ax = nx;
        ay = ny;
        left -= remaining;
        index = (index + 1) % dashes.length;
        remaining = Math.max(0.001, dashes[index]);
        drawing = !drawing;
        if (drawing) current.push([ax, ay]);
      } else {
        remaining -= left;
        if (drawing) current.push([bx, by]);
        left = 0;
      }
    }
  }
  if (drawing && current.length > 1) runs.push(current);
  return runs.length > 0 ? runs : [points];
}

export interface FloodOptions extends DrawOptions {
  /** Channel-sum distance (0..1020) within which a pixel counts as the same colour. */
  tolerance?: number;
  /** false = recolour every matching pixel on the layer, like "replace colour". */
  contiguous?: boolean;
  /** `over` paints the colour onto pixels, `replace` swaps the colour and keeps alpha. */
  mode?: "over" | "replace";
}

/** Bucket fill with a scanline walk — the classic Paint paint-bucket. */
export function floodFill(
  target: Raster,
  seedX: number,
  seedY: number,
  color: Rgba,
  options: FloodOptions = {},
): Bounds {
  if (!inBounds(target, seedX, seedY)) {
    throw new Error(`Flood fill point (${seedX},${seedY}) is outside the ${target.width}x${target.height} canvas`);
  }
  const tolerance = options.tolerance ?? 0;
  const contiguous = options.contiguous ?? true;
  const mode = options.mode ?? "over";
  const opacity = options.opacity ?? 1;
  const blend = options.blend ?? "normal";
  const seed = getPixel(target, seedX, seedY);
  const matches = (x: number, y: number): boolean => colorDistance(getPixel(target, x, y), seed) <= tolerance;
  const paint = (x: number, y: number): void => {
    if (mode === "replace") setPixel(target, x, y, color);
    else paintPixel(target, x, y, color, 1, opacity, blend);
  };
  let count = 0;
  let x0 = seedX;
  let y0 = seedY;
  let x1 = seedX;
  let y1 = seedY;
  const grow = (x: number, y: number): void => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };

  if (!contiguous) {
    for (let y = 0; y < target.height; y++) {
      for (let x = 0; x < target.width; x++) {
        if (!matches(x, y)) continue;
        paint(x, y);
        grow(x, y);
        count++;
      }
    }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  const seen = new Uint8Array(target.width * target.height);
  const stack: number[] = [seedY * target.width + seedX];
  seen[seedY * target.width + seedX] = 1;
  while (stack.length > 0) {
    const start = stack.pop() as number;
    const y = Math.floor(start / target.width);
    let left = start % target.width;
    while (left > 0 && !seen[y * target.width + left - 1] && matches(left - 1, y)) left--;
    let right = start % target.width;
    while (right < target.width - 1 && !seen[y * target.width + right + 1] && matches(right + 1, y)) right++;
    for (let px = left; px <= right; px++) {
      seen[y * target.width + px] = 1;
      paint(px, y);
      grow(px, y);
      count++;
      if (y > 0) {
        const up = (y - 1) * target.width + px;
        if (!seen[up] && matches(px, y - 1)) {
          seen[up] = 1;
          stack.push(up);
        }
      }
      if (y + 1 < target.height) {
        const down = (y + 1) * target.width + px;
        if (!seen[down] && matches(px, y + 1)) {
          seen[down] = 1;
          stack.push(down);
        }
      }
    }
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function solid(color: Rgba | string): PaintStyle {
  return { kind: "solid", color: typeof color === "string" ? parseColor(color) : color };
}

export function linearGradientStyle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stops: { at: number; color: Rgba }[],
): PaintStyle {
  return { kind: "linear", x0, y0, x1, y1, stops };
}

export function radialGradientStyle(
  cx: number,
  cy: number,
  r: number,
  stops: { at: number; color: Rgba }[],
): PaintStyle {
  return { kind: "radial", cx, cy, r, stops };
}

export function patternStyle(raster: Raster, scale = 1): PaintStyle {
  return { kind: "pattern", raster, scale: Math.max(0.01, scale) };
}
