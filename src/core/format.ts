import jpeg from "jpeg-js";
import type { Raster } from "../types.js";
import { createRaster } from "./image.js";
import { decodeBmp, encodeBmp, isBmp } from "./bmp.js";
import { decodePng, encodePng, isPng } from "./png.js";

export type ImageFormat = "png" | "jpg" | "jpeg" | "bmp";

export const SUPPORTED_FORMATS: ImageFormat[] = ["png", "jpg", "jpeg", "bmp"];

export interface EncodeOptions {
  /** 1..100 for jpeg, deflate level for png. */
  quality?: number;
  /** Force `rgb` (smaller) or keep the alpha channel in png. */
  png_color?: "auto" | "rgba" | "rgb";
}

/** Sniff the real format from magic bytes rather than trusting a file name. */
export function detectFormat(buffer: Uint8Array): ImageFormat | null {
  if (isPng(buffer)) return "png";
  if (isBmp(buffer)) return "bmp";
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  return null;
}

export function decodeImage(buffer: Buffer | Uint8Array, hint?: ImageFormat): Raster {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const format = detectFormat(bytes) ?? hint ?? null;
  if (!format) {
    throw new Error(
      `Unsupported image bytes (start: ${bytes.subarray(0, 4).toString("hex")}). Can read png, jpg, bmp.`,
    );
  }
  if (format === "png") return decodePng(bytes);
  if (format === "bmp") return decodeBmp(bytes);
  const decoded = jpeg.decode(bytes, { useTArray: true, tolerantDecoding: true });
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
}

export function encodeImage(img: Raster, format: ImageFormat, options: EncodeOptions = {}): Buffer {
  switch (format) {
    case "png":
      return encodePng(img, {
        level: options.quality === undefined ? 6 : Math.max(0, Math.min(9, Math.round(options.quality / 11))),
        color: options.png_color ?? "auto",
      });
    case "bmp":
      return encodeBmp(img);
    case "jpg":
    case "jpeg": {
      const rgb = createRaster(img.width, img.height);
      for (let i = 0; i < img.width * img.height; i++) {
        // flatten onto white because jpeg has no alpha
        const a = img.data[i * 4 + 3] / 255;
        rgb.data[i * 4] = img.data[i * 4] * a + 255 * (1 - a);
        rgb.data[i * 4 + 1] = img.data[i * 4 + 1] * a + 255 * (1 - a);
        rgb.data[i * 4 + 2] = img.data[i * 4 + 2] * a + 255 * (1 - a);
        rgb.data[i * 4 + 3] = 255;
      }
      const encoded = jpeg.encode({ data: rgb.data, width: img.width, height: img.height }, options.quality ?? 82);
      return Buffer.from(encoded.data);
    }
  }
}

export function formatFromPath(path: string): ImageFormat {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "png";
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "bmp") return "bmp";
  throw new Error(`Cannot infer an image format from "${path}" — pass format explicitly (png|jpg|bmp)`);
}
