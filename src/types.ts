/** Shared value types for the paint engine. */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A raw RGBA8 image buffer. `data.length` must equal `width * height * 4`. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ColorStop {
  /** Position along the gradient, 0..1 */
  at: number;
  color: Rgba;
}

/** How a shape interior or a stroke is coloured. */
export type PaintStyle =
  | { kind: "solid"; color: Rgba }
  | { kind: "linear"; x0: number; y0: number; x1: number; y1: number; stops: ColorStop[] }
  | { kind: "radial"; cx: number; cy: number; r: number; stops: ColorStop[] }
  | {
      kind: "pattern";
      raster: Raster;
      scale: number;
    };

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "dodge"
  | "burn"
  | "difference"
  | "exclusion"
  | "add"
  | "subtract";

export type CapStyle = "butt" | "round" | "square";
export type JoinStyle = "miter" | "round" | "bevel";

/** A polyline subpath: array of [x, y] pairs. */
export type Subpath = number[][];
/** A path is a list of subpaths; `closed` marks filled outlines. */
export interface PathShape {
  subpaths: Subpath[];
  closed: boolean;
}

/** An axis-aligned rectangle in canvas coordinates. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
