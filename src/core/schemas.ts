import { z } from "zod";
import type { PaintStyle, Rgba } from "../types.js";
import { parseColor, rgba, toRgba } from "./color.js";

/** A colour anywhere an agent can express one. */
export const ColorSchema = z.union([
  z.string().describe("CSS-ish colour: '#ff00aa', 'rgb(10,20,30)', 'hsl(210 80% 50%)', 'coral', 'gray40'"),
  z.array(z.number()).min(3).max(4).describe("[r,g,b] or [r,g,b,a] with 0-255 channels"),
  z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().min(0).max(255).default(255) }),
]);

export type ColorSpec = z.infer<typeof ColorSchema>;

export function colorOf(spec: ColorSpec): Rgba {
  if (typeof spec === "string") return parseColor(spec);
  if (Array.isArray(spec)) return rgba(spec[0], spec[1], spec[2], spec[3] ?? 255);
  return rgba(spec.r, spec.g, spec.b, spec.a);
}

export const PointSchema = z.array(z.number()).min(2).max(3).describe("[x, y] or [x, y, pressure] for brush points");
export type PointSpec = z.infer<typeof PointSchema>;

export const RectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .describe("An area of the canvas");

export type GradientSpec = {
  type?: "linear" | "radial";
  from?: number[];
  to?: number[];
  radius?: number;
  colors?: ColorSpec[];
  stops?: { at: number; color: ColorSpec }[];
};

export const GradientSchema = z.object({
  type: z.enum(["linear", "radial"]).default("linear").describe("Gradient geometry"),
  from: PointSchema.optional().describe("Start point (linear) or centre (radial). Defaults to the shape box corner/centre"),
  to: PointSchema.optional().describe("End point (linear). Defaults to the opposite corner"),
  radius: z.number().positive().optional().describe("Radius for radial gradients; defaults to the shape box diagonal"),
  colors: z.array(ColorSchema).min(2).optional().describe("Evenly spaced stops, e.g. ['#000','#fff']"),
  stops: z
    .array(z.object({ at: z.number().min(0).max(1), color: ColorSchema }))
    .min(2)
    .optional()
    .describe("Explicit stops with positions between 0 and 1"),
});

/** Anything a shape can be painted with: a flat colour or a gradient. */
export const PaintSchema = z
  .union([ColorSchema, GradientSchema])
  .describe("A colour, or a gradient object {type, from, to, radius, colors|stops}");

export type PaintSpec = z.infer<typeof PaintSchema>;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function styleOf(spec: PaintSpec, box: Box): PaintStyle {
  if (typeof spec === "string" || Array.isArray(spec) || "r" in (spec as object)) {
    return { kind: "solid", color: colorOf(spec as ColorSpec) };
  }
  const gradient = spec as GradientSpec;
  const stops = (gradient.stops ??
    (gradient.colors ?? []).map((color, index) => ({
      at: gradient.colors && gradient.colors.length > 1 ? index / (gradient.colors.length - 1) : 0,
      color: colorOf(color),
    }))).map((stop) => ({ at: stop.at, color: toRgba(stop.color) }));
  if (stops.length < 2) {
    throw new Error("A gradient needs at least two colors or stops — pass {colors:['#fff','#000']} or stops");
  }
  if (gradient.type === "radial") {
    const cx = gradient.from?.[0] ?? box.x + box.width / 2;
    const cy = gradient.from?.[1] ?? box.y + box.height / 2;
    const r = gradient.radius ?? Math.hypot(box.width, box.height) / 2;
    return { kind: "radial", cx, cy, r, stops };
  }
  const x0 = gradient.from?.[0] ?? box.x;
  const y0 = gradient.from?.[1] ?? box.y;
  const x1 = gradient.to?.[0] ?? box.x + box.width;
  const y1 = gradient.to?.[1] ?? box.y + box.height;
  return { kind: "linear", x0, y0, x1, y1, stops };
}

/** Small helper so ops can accept a plain colour spec and get RGBA back. */
export function solidOf(spec: ColorSpec): Rgba {
  return colorOf(spec);
}
