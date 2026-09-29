import type { Raster } from "../types.js";
import { cropRaster, resizeRaster } from "../core/image.js";
import { encodePng } from "../core/png.js";
import type { PreviewSetting } from "./config.js";

export interface PreviewRequest {
  preview?: PreviewSetting;
  /** Longest edge of the returned thumbnail. */
  size?: number;
  region?: { x: number; y: number; width: number; height: number };
}

export interface BuiltPreview {
  mode: PreviewSetting;
  width: number;
  height: number;
  bytes: number;
  content?: { type: "image"; data: string; mimeType: "image/png" };
  note?: string;
}

const MAX_FULL_PIXELS = 2_000_000;

/**
 * Turns a raster into the image block of a tool result, so the agent can look at
 * what it just drew. `auto` means "give me a thumbnail".
 */
export function buildPreview(
  image: Raster,
  request: PreviewRequest,
  defaults: { preview: PreviewSetting; previewSize: number },
): BuiltPreview {
  const mode = request.preview ?? defaults.preview;
  if (mode === "none") return { mode, width: image.width, height: image.height, bytes: 0 };

  let working = image;
  if (request.region) {
    const region = request.region;
    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));
    const width = Math.min(working.width - x, Math.max(1, Math.floor(region.width)));
    const height = Math.min(working.height - y, Math.max(1, Math.floor(region.height)));
    working = cropRaster(working, x, y, width, height);
  }

  const maxEdge = Math.max(32, Math.min(4096, request.size ?? defaults.previewSize));
  let note: string | undefined;
  if (mode === "thumb" || mode === "auto") {
    if (Math.max(working.width, working.height) > maxEdge) {
      const scale = maxEdge / Math.max(working.width, working.height);
      const before = `${working.width}x${working.height}`;
      working = resizeRaster(working, Math.max(1, Math.round(working.width * scale)), Math.max(1, Math.round(working.height * scale)));
      note = `preview downscaled from ${before} to ${working.width}x${working.height}`;
    }
  } else if (working.width * working.height > MAX_FULL_PIXELS) {
    note = `full-size preview is ${(working.width * working.height / 1_000_000).toFixed(1)}MP and costs a lot of tokens — prefer preview:"thumb"`;
  }

  const png = encodePng(working, { level: mode === "auto" || mode === "thumb" ? 6 : 3 });
  return {
    mode,
    width: working.width,
    height: working.height,
    bytes: png.length,
    content: { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    note,
  };
}
