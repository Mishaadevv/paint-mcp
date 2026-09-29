import { z } from "zod";
import type { BlendMode, Bounds, PaintStyle, Raster, Subpath } from "../types.js";
import { colorOf, ColorSchema, PaintSchema, styleOf, type ColorSpec, type PaintSpec } from "./schemas.js";
import {
  alphaBounds,
  BLEND_MODES,
  composite,
  createRaster,
  cropRaster,
  flipRaster,
  padRaster,
  rasterFilled,
  resizeRaster,
  rotateRasterBilinear,
  setPixel,
} from "./image.js";
import { boundsOf, brushStroke, fillPath, floodFill, linearGradientStyle, radialGradientStyle, solid, strokePath, type DrawOptions } from "./raster.js";
import { closedPath, ellipseSubpath, lineSubpath, openPath, parseSvgPath, rectSubpath, roundedRectSubpath } from "./path.js";
import { applyFilter, FILTER_NAMES, type FilterName } from "./filter.js";
import { measureText, renderText, transliterate, supportedCharacters } from "./font.js";
import type { PaintDocument } from "./document.js";

/** Hands an op an image from a name or a file path. */
export type ImageResolver = (ref: string) => Raster;

export interface OpContext {
  doc: PaintDocument;
  resolve: ImageResolver;
}

export interface OpDefinition {
  title: string;
  description: string;
  schema: z.ZodType;
  /** Layers that need a pixel snapshot for undo. */
  scope: "layer" | "all";
  /** Replayable as vector geometry (used by SVG export). */
  vector?: boolean;
  destructive?: boolean;
  apply: (ctx: OpContext, params: Record<string, unknown>) => string;
}

const LayerParam = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Target layer index; defaults to the active layer (see paint_canvas).");
const OpacityParam = z.number().min(0).max(1).default(1).describe("0..1 strength of this stroke");
const BlendParam = z.enum(BLEND_MODES as [BlendMode, ...BlendMode[]]).default("normal").describe("Blend mode for this stroke");
const AreaParam = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive().max(20000),
    height: z.number().positive().max(20000),
  })
  .optional()
  .describe("Restrict to a rectangle; omit for the whole canvas");

const withCommon = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, layer: LayerParam, opacity: OpacityParam, blend: BlendParam }).strict();

function op<S extends z.ZodType>(def: {
  title: string;
  description: string;
  schema: S;
  scope?: "layer" | "all";
  vector?: boolean;
  destructive?: boolean;
  apply: (ctx: OpContext, params: z.infer<S>) => string;
}): OpDefinition {
  return {
    title: def.title,
    description: def.description,
    schema: def.schema,
    scope: def.scope ?? "layer",
    vector: def.vector,
    destructive: def.destructive,
    apply: def.apply as (ctx: OpContext, params: Record<string, unknown>) => string,
  };
}

function options(params: { opacity: number; blend: BlendMode }): DrawOptions {
  return { opacity: params.opacity, blend: params.blend };
}

function toSubpath(input: (number[])[]): Subpath {
  return input.map((p) => [p[0], p[1], p[2] ?? 1]);
}

function requirePaint(params: { fill?: PaintSpec; stroke?: PaintSpec }, what: string): void {
  if (!params.fill && !params.stroke) {
    throw new Error(`${what} needs "fill" and/or "stroke" — e.g. fill:"#2266ff" or stroke:{colors:["#000","#fff"]}`);
  }
}

function outlineOf(stroke: PaintSpec | undefined, box: Bounds): PaintStyle | null {
  return stroke ? styleOf(stroke, box) : null;
}

/** Erase = subtract alpha, which source-over compositing cannot express. */
function eraseRegion(layer: Raster, path: { subpaths: Subpath[]; closed: boolean }, opacity: number): void {
  const bounds = boundsOf(path);
  const x0 = Math.max(0, Math.floor(bounds.x));
  const y0 = Math.max(0, Math.floor(bounds.y));
  const width = Math.min(layer.width - x0, Math.ceil(bounds.x + bounds.width) + 1 - x0);
  const height = Math.min(layer.height - y0, Math.ceil(bounds.y + bounds.height) + 1 - y0);
  if (width <= 0 || height <= 0) return;
  const shifted = {
    subpaths: path.subpaths.map((sub) => sub.map(([x, y]) => [x - x0, y - y0])),
    closed: path.closed,
  };
  const mask = createRaster(width, height);
  fillPath(mask, shifted, solid({ r: 255, g: 255, b: 255, a: 255 }), {});
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const remove = mask.data[(y * width + x) * 4 + 3] * Math.max(0, Math.min(1, opacity));
      if (remove <= 0) continue;
      const tx = x0 + x;
      const ty = y0 + y;
      if (tx >= layer.width || ty >= layer.height) continue;
      const i = (ty * layer.width + tx) * 4;
      layer.data[i + 3] = Math.max(0, layer.data[i + 3] - remove);
    }
  }
}

function wrapText(text: string, maxWidth: number): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= maxWidth) return [line];
      const out: string[] = [];
      let rest = line;
      while (rest.length > maxWidth) {
        const cut = rest.lastIndexOf(" ", maxWidth) > 0 ? rest.lastIndexOf(" ", maxWidth) : maxWidth;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ +/, "");
      }
      out.push(rest);
      return out;
    })
    .join("\n");
}

export const OPS: Record<string, OpDefinition> = {
  rect: op({
    title: "Rectangle",
    vector: true,
    description:
      "Filled and/or outlined rectangle. `radius` rounds the corners (number, or [top-left, top-right, bottom-right, bottom-left]). fill/stroke take a colour or a gradient object.",
    schema: withCommon({
      x: z.number(),
      y: z.number(),
      width: z.number().min(0).max(20000),
      height: z.number().min(0).max(20000),
      radius: z.union([z.number().min(0), z.array(z.number().min(0)).length(4)]).optional().describe("Corner radius in pixels"),
      fill: PaintSchema.optional(),
      stroke: PaintSchema.optional(),
      stroke_width: z.number().min(0.1).max(500).default(2),
    }),
    apply: (ctx, p) => {
      requirePaint(p, "rect");
      const box = { x: p.x, y: p.y, width: p.width, height: p.height };
      const layer = ctx.doc.layerAt(p.layer).raster;
      const outline = p.radius
        ? roundedRectSubpath(p.x, p.y, p.width, p.height, p.radius)
        : rectSubpath(p.x, p.y, p.width, p.height);
      if (p.fill) fillPath(layer, closedPath(outline), styleOf(p.fill, box), options(p));
      const line = outlineOf(p.stroke, box);
      if (line) strokePath(layer, closedPath(outline), line, { ...options(p), width: p.stroke_width, cap: "butt" });
      return `${p.width}x${p.height} rect at (${p.x},${p.y})`;
    },
  }),

  ellipse: op({
    title: "Ellipse, circle or arc",
    vector: true,
    description:
      "Circle (`radius`) or ellipse (`rx`,`ry`). `start_angle`/`end_angle` in degrees cut an arc; `pie:true` closes it to the centre; `rotation` tilts the shape.",
    schema: withCommon({
      cx: z.number(),
      cy: z.number(),
      radius: z.number().positive().max(20000).optional(),
      rx: z.number().positive().max(20000).optional(),
      ry: z.number().positive().max(20000).optional(),
      start_angle: z.number().min(-720).max(720).default(0),
      end_angle: z.number().min(-720).max(720).default(360),
      rotation: z.number().min(-360).max(360).default(0),
      pie: z.boolean().default(false),
      fill: PaintSchema.optional(),
      stroke: PaintSchema.optional(),
      stroke_width: z.number().min(0.1).max(500).default(2),
    }),
    apply: (ctx, p) => {
      requirePaint(p, "ellipse");
      const rx = p.radius ?? p.rx;
      const ry = p.radius ?? p.ry;
      if (!rx || !ry) throw new Error("ellipse needs `radius` or both `rx` and `ry`");
      const partialArc = (p.start_angle !== 0 || p.end_angle !== 360) && !p.pie;
      let sub = ellipseSubpath(p.cx, p.cy, rx, ry, p.start_angle, p.end_angle, p.rotation);
      if (p.pie) sub = [[p.cx, p.cy], ...sub];
      const box = { x: p.cx - rx, y: p.cy - ry, width: rx * 2, height: ry * 2 };
      const layer = ctx.doc.layerAt(p.layer).raster;
      if (p.fill) fillPath(layer, closedPath(sub), styleOf(p.fill, box), options(p));
      const line = outlineOf(p.stroke, box);
      if (line) {
        const path = partialArc ? openPath(sub) : closedPath(sub);
        strokePath(layer, path, line, { ...options(p), width: p.stroke_width, cap: "round" });
      }
      return `${partialArc ? "arc" : "ellipse"} ${rx}x${ry} at (${p.cx},${p.cy})`;
    },
  }),

  line: op({
    title: "Straight line",
    vector: true,
    description:
      "One segment, with optional `dashes` ([8,6]) and `arrow` head. `hardness` 0 gives an airbrush edge. For rules, grids and outlines.",
    schema: withCommon({
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      color: PaintSchema.describe("Line colour or gradient"),
      width: z.number().min(0.1).max(2000).default(2),
      cap: z.enum(["butt", "round", "square"]).default("round"),
      hardness: z.number().min(0).max(1).default(1),
      dashes: z.array(z.number().positive()).optional(),
      dash_offset: z.number().default(0),
      arrow: z.enum(["none", "start", "end", "both"]).default("none"),
      arrow_size: z.number().min(2).max(2000).default(14),
    }),
    apply: (ctx, p) => {
      const layer = ctx.doc.layerAt(p.layer).raster;
      const box = { x: Math.min(p.x1, p.x2), y: Math.min(p.y1, p.y2), width: Math.abs(p.x2 - p.x1), height: Math.abs(p.y2 - p.y1) };
      const style = styleOf(p.color, box);
      strokePath(layer, openPath(lineSubpath(p.x1, p.y1, p.x2, p.y2)), style, {
        ...options(p),
        width: p.width,
        cap: p.cap,
        hardness: p.hardness,
        dashes: p.dashes,
        dashOffset: p.dash_offset,
      });
      if (p.arrow !== "none") {
        const angle = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
        const head = (x: number, y: number, direction: number): void => {
          for (const sign of [1, -1]) {
            strokePath(
              layer,
              openPath(
                lineSubpath(
                  x,
                  y,
                  x + Math.cos(direction + sign * (Math.PI / 7)) * p.arrow_size,
                  y + Math.sin(direction + sign * (Math.PI / 7)) * p.arrow_size,
                ),
              ),
              style,
              { ...options(p), width: p.width, cap: "round" },
            );
          }
        };
        if (p.arrow === "end" || p.arrow === "both") head(p.x2, p.y2, angle + Math.PI);
        if (p.arrow === "start" || p.arrow === "both") head(p.x1, p.y1, angle);
      }
      return `line (${p.x1},${p.y1})→(${p.x2},${p.y2}) width ${p.width}`;
    },
  }),

  polygon: op({
    title: "Polygon or polyline",
    vector: true,
    description: "Any many-sided shape from [x,y] points — stars, arrows, speech bubbles. `closed:false` strokes the outline only.",
    schema: withCommon({
      points: z.array(z.array(z.number()).min(2).max(3)).min(2).max(20000).describe("Corners as [[x,y], …]"),
      closed: z.boolean().default(true),
      fill: PaintSchema.optional(),
      stroke: PaintSchema.optional(),
      stroke_width: z.number().min(0.1).max(500).default(2),
      even_odd: z.boolean().default(false).describe("Even-odd rule, needed for self-crossing stars"),
    }),
    apply: (ctx, p) => {
      requirePaint(p, "polygon");
      const sub = p.points.map((pt) => [pt[0], pt[1]]);
      const path = p.closed ? closedPath(sub) : openPath(sub);
      const box = boundsOf(path);
      const layer = ctx.doc.layerAt(p.layer).raster;
      if (p.fill) fillPath(layer, path, styleOf(p.fill, box), { ...options(p), evenOdd: p.even_odd });
      const line = outlineOf(p.stroke, box);
      if (line) strokePath(layer, path, line, { ...options(p), width: p.stroke_width });
      return `${p.points.length}-point ${p.closed ? "polygon" : "polyline"}`;
    },
  }),

  path: op({
    title: "SVG path data",
    vector: true,
    description:
      "Draw SVG path `d` data (M L H V C S Q T A Z, lowercase = relative) — the compact way for an agent to place curved or complex art. Supports fill, stroke, dashes, even-odd.",
    schema: withCommon({
      d: z.string().min(1).max(200000).describe("Content of an SVG `d` attribute"),
      fill: PaintSchema.optional(),
      stroke: PaintSchema.optional(),
      stroke_width: z.number().min(0.1).max(500).default(2),
      even_odd: z.boolean().default(false),
      dashes: z.array(z.number().positive()).optional(),
      cap: z.enum(["butt", "round", "square"]).default("round"),
      translate: z.array(z.number()).length(2).optional().describe("Offset by [dx, dy]"),
      scale: z.number().positive().max(1000).optional().describe("Uniform scale around the origin"),
    }),
    apply: (ctx, p) => {
      requirePaint(p, "path");
      const parsed = parseSvgPath(p.d);
      const moved = parsed.subpaths.map((sub) =>
        sub.map(([x, y]) => {
          const sx = p.scale ? x * p.scale : x;
          const sy = p.scale ? y * p.scale : y;
          return p.translate ? [sx + p.translate[0], sy + p.translate[1]] : [sx, sy];
        }),
      );
      const path = { subpaths: moved, closed: parsed.closed };
      const box = boundsOf(path);
      const layer = ctx.doc.layerAt(p.layer).raster;
      if (p.fill) fillPath(layer, { ...path, closed: true }, styleOf(p.fill, box), { ...options(p), evenOdd: p.even_odd });
      const line = outlineOf(p.stroke, box);
      if (line) strokePath(layer, path, line, { ...options(p), width: p.stroke_width, cap: p.cap, dashes: p.dashes });
      return `path: ${moved.length} subpath(s), ${moved.reduce((a, s) => a + s.length, 0)} points`;
    },
  }),

  brush: op({
    title: "Freehand brush stroke",
    description:
      "Mouse-drag feel: soft stamps along a polyline. Each point may carry a third value 0..1 as pressure. `flatten`+`angle` make a calligraphy nib, `jitter` a hand wobble, low `hardness` a spray.",
    schema: withCommon({
      points: z
        .array(z.array(z.number()).min(2).max(3))
        .min(1)
        .max(50000)
        .describe("Stroke path as [[x,y], …]; add a third value 0..1 per point for pressure"),
      color: PaintSchema.describe("Brush colour or gradient"),
      size: z.number().min(0.5).max(4000).default(12),
      hardness: z.number().min(0).max(1).default(0.85),
      spacing: z.number().min(0.02).max(2).default(0.18).describe("Stamp gap as a fraction of size"),
      jitter: z.number().min(0).max(1).default(0),
      flatten: z.number().min(0).max(0.95).default(0),
      angle: z.number().min(-360).max(360).default(0),
      seed: z.number().int().optional().describe("Deterministic jitter seed"),
    }),
    apply: (ctx, p) => {
      const layer = ctx.doc.layerAt(p.layer).raster;
      const sub = toSubpath(p.points);
      const box = boundsOf({ subpaths: [sub], closed: false });
      brushStroke(layer, sub, styleOf(p.color, box), {
        ...options(p),
        size: p.size,
        hardness: p.hardness,
        spacing: p.spacing,
        jitter: p.jitter,
        flatten: p.flatten,
        angle: p.angle,
        seed: p.seed,
      });
      return `brush stroke of ${sub.length} point(s), size ${p.size}`;
    },
  }),

  text: op({
    title: "Text label",
    vector: true,
    description:
      "Writes text with the built-in 5x7 pixel font (ASCII). `scale` multiplies the pixel size, `align`/`valign` anchor around (x,y), `max_width` wraps. Non-ASCII is transliterated (or errors) — no font files needed.",
    schema: withCommon({
      text: z.string().max(20000),
      x: z.number(),
      y: z.number(),
      scale: z.number().min(1).max(64).default(3),
      color: ColorSchema.default("#000000"),
      outline: z.number().min(0).max(8).default(0).describe("Outline thickness in glyph pixels"),
      outline_color: ColorSchema.optional(),
      align: z.enum(["left", "center", "right"]).default("left"),
      valign: z.enum(["top", "middle", "bottom"]).default("top"),
      max_width: z.number().int().min(1).optional().describe("Wrap after N characters"),
      letter_spacing: z.number().min(0).max(20).default(1),
      line_spacing: z.number().min(0).max(40).default(2),
      unicode: z.enum(["transliterate", "skip", "error"]).default("transliterate"),
    }),
    apply: (ctx, p) => {
      let text = p.text;
      if (p.max_width) text = wrapText(text, p.max_width);
      const missing = [...text].filter((c) => c !== "\n" && !supportedCharacters.includes(c));
      if (missing.length > 0) {
        if (p.unicode === "error") {
          throw new Error(
            `The built-in font has no glyphs for "${[...new Set(missing)].slice(0, 8).join("")}". Use unicode:"transliterate", or draw lettering with path/brush.`,
          );
        }
        text = p.unicode === "skip" ? [...text].map((c) => (supportedCharacters.includes(c) ? c : " ")).join("") : transliterate(text);
      }
      const layer = ctx.doc.layerAt(p.layer).raster;
      const tile = renderText(text, {
        scale: p.scale,
        letterSpacing: p.letter_spacing,
        lineSpacing: p.line_spacing,
        color: colorOf(p.color),
        outline: p.outline,
        outlineColor: p.outline_color ? colorOf(p.outline_color) : undefined,
      });
      const size = measureText(text, p.scale, p.letter_spacing);
      const x = Math.round(p.align === "left" ? p.x : p.align === "center" ? p.x - size.width / 2 : p.x - size.width);
      const y = Math.round(p.valign === "top" ? p.y : p.valign === "middle" ? p.y - size.height / 2 : p.y - size.height);
      composite(layer, tile, { x, y, opacity: p.opacity, blend: p.blend });
      return `text "${text.slice(0, 40).replace(/\n/g, "\\n")}" at (${x},${y})`;
    },
  }),

  pixel_grid: op({
    title: "Pixel-art sprite from text rows",
    description:
      "Draws a sprite where each character of `rows` looks up a colour in `palette` (space and `.` are skipped) and fills a `cell`x`cell` block, starting at `origin`. Perfect for sprites, tiles, icons and logos.",
    schema: z
      .object({
        rows: z.array(z.string()).min(1).max(4000),
        palette: z.record(z.string(), ColorSchema).describe("Character → colour map"),
        origin: z.array(z.number()).length(2).default([0, 0]),
        cell: z.number().int().min(1).max(200).default(1),
        layer: LayerParam,
        opacity: OpacityParam,
        blend: BlendParam,
      })
      .strict(),
    apply: (ctx, p) => {
      const layer = ctx.doc.layerAt(p.layer).raster;
      const [ox, oy] = p.origin;
      const lookup = new Map(Object.entries(p.palette).map(([char, spec]) => [char, colorOf(spec)]));
      let cells = 0;
      p.rows.forEach((row, ry) => {
        [...row].forEach((char, rx) => {
          const color = lookup.get(char);
          if (!color) return;
          cells++;
          fillPath(
            layer,
            closedPath(rectSubpath(ox + rx * p.cell, oy + ry * p.cell, p.cell, p.cell)),
            solid(color),
            options(p),
          );
        });
      });
      if (cells === 0) throw new Error("pixel_grid painted nothing — check that row characters exist in `palette`");
      return `sprite ${p.rows[0].length}x${p.rows.length} cells, ${cells} painted at cell ${p.cell}`;
    },
  }),

  pixels: op({
    title: "Write single pixels",
    description:
      "Exact pixel writes (no blending): pixels=[{x,y,color}, {x,y,width,height,color}, or [x,y,0xRRGGBB]]. Use for pixel art and small fixes.",
    schema: z
      .object({
        pixels: z
          .array(
            z.union([
              z.object({ x: z.number().int(), y: z.number().int(), color: ColorSchema }),
              z.object({
                x: z.number().int(),
                y: z.number().int(),
                width: z.number().int().min(1).max(5000),
                height: z.number().int().min(1).max(5000),
                color: ColorSchema,
              }),
              z.array(z.number().int()).length(3).describe("[x, y, packed 0xRRGGBB]"),
            ]),
          )
          .min(1)
          .max(200000),
        layer: LayerParam,
      })
      .strict(),
    apply: (ctx, p) => {
      const layer = ctx.doc.layerAt(p.layer).raster;
      let count = 0;
      for (const item of p.pixels) {
        if (Array.isArray(item)) {
          const [x, y, packed] = item;
          setPixel(layer, x, y, { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255, a: 255 });
          count++;
          continue;
        }
        const color = colorOf(item.color);
        const width = "width" in item ? item.width : 1;
        const height = "height" in item ? item.height : 1;
        for (let dy = 0; dy < height; dy++) {
          for (let dx = 0; dx < width; dx++) {
            setPixel(layer, item.x + dx, item.y + dy, color);
            count++;
          }
        }
      }
      return `${count} pixel(s) written`;
    },
  }),

  fill: op({
    title: "Bucket fill / recolour",
    description:
      "Paint bucket. `tolerance` is summed channel distance (0 = exact, 60 ≈ shades of the same hue). `contiguous:false` hits every matching pixel of the layer; `mode:'replace'` swaps the colour instead of painting over it.",
    schema: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        color: ColorSchema,
        tolerance: z.number().min(0).max(1020).default(0),
        contiguous: z.boolean().default(true),
        mode: z.enum(["over", "replace"]).default("over"),
        layer: LayerParam,
        opacity: OpacityParam,
        blend: BlendParam,
      })
      .strict(),
    apply: (ctx, p) => {
      const layer = ctx.doc.layerAt(p.layer).raster;
      const area = floodFill(layer, p.x, p.y, colorOf(p.color), {
        tolerance: p.tolerance,
        contiguous: p.contiguous,
        mode: p.mode,
        opacity: p.opacity,
        blend: p.blend,
      });
      return `bucket filled ${area.width}x${area.height} from (${p.x},${p.y})`;
    },
  }),

  gradient: op({
    title: "Gradient wash",
    description: "Linear or radial gradient over the canvas or an `area` — skies, glows, metal, shadows.",
    schema: withCommon({
      type: z.enum(["linear", "radial"]).default("linear"),
      from: z.array(z.number()).length(2).optional().describe("Start point (linear) or centre (radial)"),
      to: z.array(z.number()).length(2).optional().describe("End point (linear only)"),
      radius: z.number().positive().optional().describe("Radial radius"),
      colors: z.array(ColorSchema).min(2).max(16).describe("Evenly spaced colours"),
      stops: z.array(z.object({ at: z.number().min(0).max(1), color: ColorSchema })).min(2).max(16).optional(),
      area: AreaParam,
      shape: z.enum(["rect", "ellipse"]).default("rect"),
    }),
    apply: (ctx, p) => {
      const layer = ctx.doc.layerAt(p.layer).raster;
      const area = p.area ?? { x: 0, y: 0, width: ctx.doc.width, height: ctx.doc.height };
      const stops = (p.stops ?? p.colors.map((color, index) => ({ at: index / (p.colors.length - 1), color }))).map(
        (stop: { at: number; color: ColorSpec }) => ({ at: stop.at, color: colorOf(stop.color) }),
      );
      const style =
        p.type === "radial"
          ? radialGradientStyle(p.from?.[0] ?? area.x + area.width / 2, p.from?.[1] ?? area.y + area.height / 2, p.radius ?? Math.hypot(area.width, area.height) / 2, stops)
          : linearGradientStyle(p.from?.[0] ?? area.x, p.from?.[1] ?? area.y, p.to?.[0] ?? area.x + area.width, p.to?.[1] ?? area.y + area.height, stops);
      const shape =
        p.shape === "ellipse"
          ? closedPath(ellipseSubpath(area.x + area.width / 2, area.y + area.height / 2, area.width / 2, area.height / 2))
          : closedPath(rectSubpath(area.x, area.y, area.width, area.height));
      fillPath(layer, shape, style, options(p));
      return `${p.type} ${p.shape} gradient across ${area.width}x${area.height}`;
    },
  }),

  stamp: op({
    title: "Stamp an image",
    description:
      "Places another canvas or an image file onto this layer. `source` is a canvas name or a path under the paint root (png/jpg/bmp). Supports scale, rotate, opacity, blend, `region` crop and `tile`.",
    schema: withCommon({
      source: z.string().min(1).describe("Canvas name or image file path"),
      x: z.number().default(0),
      y: z.number().default(0),
      scale: z.number().min(0.01).max(100).default(1),
      rotate: z.number().min(-360).max(360).default(0),
      region: AreaParam.describe("Crop rectangle inside the source"),
      tile: z.boolean().default(false),
    }),
    apply: (ctx, p) => {
      let image = ctx.resolve(p.source);
      if (p.region) image = cropRaster(image, Math.round(p.region.x), Math.round(p.region.y), Math.round(p.region.width), Math.round(p.region.height));
      const layer = ctx.doc.layerAt(p.layer).raster;
      if (p.tile) {
        const stepX = Math.max(1, Math.round(image.width * p.scale));
        const stepY = Math.max(1, Math.round(image.height * p.scale));
        for (let y = p.y; y < ctx.doc.height; y += stepY) {
          for (let x = p.x; x < ctx.doc.width; x += stepX) {
            composite(layer, image, { x, y, scale: p.scale, opacity: p.opacity, blend: p.blend });
          }
        }
        return `tiled ${p.source} over the canvas`;
      }
      const rotated = p.rotate ? rotateRasterBilinear(image, p.rotate) : image;
      composite(layer, rotated, {
        x: Math.round(p.x - (rotated.width - image.width) / 2),
        y: Math.round(p.y - (rotated.height - image.height) / 2),
        scale: p.scale,
        opacity: p.opacity,
        blend: p.blend,
      });
      return `stamped ${image.width}x${image.height} ${p.source} at (${p.x},${p.y})`;
    },
  }),

  clear: op({
    title: "Clear or erase an area",
    destructive: true,
    description:
      "Wipes a rectangle (whole layer when `area` omitted) to `color`; `color:null` erases to transparency. `shape:'ellipse'` and `radius` round the mask.",
    schema: z
      .object({
        layer: LayerParam,
        area: AreaParam,
        color: ColorSchema.nullable().optional().describe("Fill colour, or null to erase to transparent"),
        shape: z.enum(["rect", "ellipse"]).default("rect"),
        radius: z.number().min(0).optional(),
        opacity: z.number().min(0).max(1).default(1),
      })
      .strict(),
    apply: (ctx, p) => {
      const layer = ctx.doc.layerAt(p.layer).raster;
      const area = p.area ?? { x: 0, y: 0, width: ctx.doc.width, height: ctx.doc.height };
      const shape =
        p.shape === "ellipse"
          ? closedPath(ellipseSubpath(area.x + area.width / 2, area.y + area.height / 2, area.width / 2, area.height / 2))
          : closedPath(p.radius ? roundedRectSubpath(area.x, area.y, area.width, area.height, p.radius) : rectSubpath(area.x, area.y, area.width, area.height));
      if (p.color === null || p.color === undefined) eraseRegion(layer, shape, p.opacity);
      else fillPath(layer, shape, solid(colorOf(p.color)), { opacity: p.opacity });
      return `${p.color === null || p.color === undefined ? "erased" : "filled"} ${area.width}x${area.height} on layer ${ctx.doc.activeIndex}`;
    },
  }),

  filter: op({
    title: "Image filter",
    description:
      `Filters a layer: ${FILTER_NAMES.join(", ")}. \`amount\` is per filter (blur px, degrees, +/- levels, multiplier); \`area\` limits it; \`level\` = posterize/dither levels.`,
    schema: z
      .object({
        layer: LayerParam,
        name: z.enum(FILTER_NAMES as [FilterName, ...FilterName[]]),
        amount: z.number().min(-1000).max(10000).optional(),
        level: z.number().min(1).max(64).optional(),
        seed: z.number().int().optional(),
        area: AreaParam,
      })
      .strict(),
    apply: (ctx, p) => {
      const layer = ctx.doc.layerAt(p.layer).raster;
      applyFilter(layer, p.name, { amount: p.amount, level: p.level, seed: p.seed }, p.area);
      return `${p.name}${p.area ? ` on ${Math.round(p.area.width)}x${Math.round(p.area.height)}` : " on the whole layer"}`;
    },
  }),

  transform: op({
    title: "Transform a layer or the canvas",
    destructive: true,
    scope: "all",
    description:
      "scale | rotate | flip | translate on one layer; crop | resize | trim on the whole canvas. Bilinear resampling; `trim` shrinks to painted content.",
    schema: z
      .object({
        layer: LayerParam,
        mode: z.enum(["scale", "rotate", "flip", "translate", "crop", "resize", "trim"]),
        factor: z.number().min(0.01).max(100).default(1).describe("scale multiplier"),
        width: z.number().int().min(1).max(20000).optional(),
        height: z.number().int().min(1).max(20000).optional(),
        x: z.number().default(0),
        y: z.number().default(0),
        degrees: z.number().min(-3600).max(3600).default(0),
        axis: z.enum(["horizontal", "vertical", "both"]).default("horizontal"),
        anchor: z.enum(["center", "top-left", "top", "bottom", "left", "right"]).default("center"),
        background: ColorSchema.nullable().optional().describe("Bottom-layer colour when growing the canvas"),
      })
      .strict(),
    apply: (ctx, p) => {
      const doc = ctx.doc;
      const layer = doc.layerAt(p.layer);
      const anchor = p.anchor === "top-left" ? "top-left" : p.anchor;
      switch (p.mode) {
        case "scale": {
          layer.raster = resizeRaster(
            layer.raster,
            Math.max(1, Math.round(layer.raster.width * p.factor)),
            Math.max(1, Math.round(layer.raster.height * p.factor)),
          );
          return `layer scaled x${p.factor} → ${layer.raster.width}x${layer.raster.height}`;
        }
        case "rotate": {
          const rotated = rotateRasterBilinear(layer.raster, p.degrees);
          layer.raster =
            rotated.width === doc.width && rotated.height === doc.height ? rotated : padRaster(rotated, doc.width, doc.height, "center");
          return `layer rotated ${p.degrees}°`;
        }
        case "flip":
          layer.raster = flipRaster(layer.raster, p.axis);
          return `layer flipped ${p.axis}`;
        case "translate": {
          const next = createRaster(doc.width, doc.height);
          composite(next, layer.raster, { x: Math.round(p.x), y: Math.round(p.y) });
          layer.raster = next;
          return `layer moved by (${p.x},${p.y})`;
        }
        case "crop": {
          const width = p.width ?? doc.width;
          const height = p.height ?? doc.height;
          for (const item of doc.layers) item.raster = cropRaster(item.raster, Math.round(p.x), Math.round(p.y), width, height);
          doc.width = width;
          doc.height = height;
          return `canvas cropped to ${width}x${height} at (${p.x},${p.y})`;
        }
        case "resize": {
          const width = p.width ?? doc.width;
          const height = p.height ?? doc.height;
          for (const item of doc.layers) {
            let next = padRaster(item.raster, width, height, anchor);
            if (item === doc.layers[0] && p.background) {
              const base = rasterFilled(width, height, colorOf(p.background));
              composite(base, next);
              next = base;
            }
            item.raster = next;
          }
          doc.width = width;
          doc.height = height;
          return `canvas resized to ${width}x${height}`;
        }
        case "trim": {
          const merged = doc.composite();
          const bounds = alphaBounds(merged) ?? { x: 0, y: 0, width: doc.width, height: doc.height };
          for (const item of doc.layers) item.raster = cropRaster(item.raster, bounds.x, bounds.y, bounds.width, bounds.height);
          doc.width = bounds.width;
          doc.height = bounds.height;
          return `trimmed to ${bounds.width}x${bounds.height} at (${bounds.x},${bounds.y})`;
        }
      }
    },
  }),

  layer: op({
    title: "Manage layers",
    scope: "all",
    description:
      "list | add | remove | select | move | merge | set (rename, opacity, blend, visible). Layers stack bottom→top; index 0 is the bottom one.",
    schema: z
      .object({
        action: z.enum(["list", "add", "remove", "select", "move", "merge", "set"]),
        index: z.number().int().min(0).optional(),
        to: z.number().int().min(0).optional().describe("Destination index for move"),
        name: z.string().max(60).optional(),
        opacity: z.number().min(0).max(1).optional(),
        blend: z.enum(BLEND_MODES as [BlendMode, ...BlendMode[]]).optional(),
        visible: z.boolean().optional(),
        below: z.boolean().default(false).describe("Insert below the active layer"),
      })
      .strict(),
    apply: (ctx, p) => {
      const doc = ctx.doc;
      switch (p.action) {
        case "list":
          return doc.describeLayers();
        case "add": {
          const added = doc.addLayer(p.name, { opacity: p.opacity, blend: p.blend, below: p.below });
          return `added layer ${doc.activeIndex} "${added.name}"`;
        }
        case "remove": {
          const index = p.index ?? doc.activeIndex;
          const name = doc.layers[index]?.name ?? String(index);
          doc.removeLayer(index);
          return `removed layer ${index} "${name}"`;
        }
        case "select": {
          if (p.index === undefined) throw new Error("layer select needs `index`");
          if (!doc.layers[p.index]) throw new Error(`No layer ${p.index}. Layers: ${doc.describeLayers()}`);
          doc.active = p.index;
          return `active layer ${p.index} "${doc.layers[p.index].name}"`;
        }
        case "move": {
          if (p.to === undefined) throw new Error("layer move needs `to`");
          const from = p.index ?? doc.activeIndex;
          doc.moveLayer(from, p.to);
          return `moved layer ${from} → ${p.to}`;
        }
        case "merge": {
          const index = p.index ?? doc.activeIndex;
          doc.mergeDown(index);
          return `merged layer ${index} into ${Math.max(0, index - 1)}`;
        }
        case "set": {
          const item = doc.layerAt(p.index);
          if (p.name !== undefined) item.name = p.name;
          if (p.opacity !== undefined) item.opacity = p.opacity;
          if (p.blend !== undefined) item.blend = p.blend;
          if (p.visible !== undefined) item.visible = p.visible;
          return `layer updated: ${doc.describeLayers()}`;
        }
      }
    },
  }),
};

export function describeOps(): string {
  return Object.entries(OPS)
    .map(([name, def]) => `- ${name}: ${def.title}. ${def.description.split(".")[0]}.`)
    .join("\n");
}

export { createRaster, solid };
