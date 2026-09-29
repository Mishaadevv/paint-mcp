import type { Raster } from "../types.js";
import { createRaster } from "./image.js";

/** Windows BMP read/write — the format MS Paint itself uses. */

export function isBmp(buffer: Uint8Array): boolean {
  return buffer.length > 54 && buffer[0] === 0x42 && buffer[1] === 0x4d;
}

export function encodeBmp(img: Raster): Buffer {
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const bits = opaque ? 24 : 32;
  const bytesPerPixel = bits / 8;
  const rowSize = Math.ceil((img.width * bytesPerPixel) / 4) * 4;
  const pixelsSize = rowSize * img.height;
  const headerSize = 14 + 40;
  const out = Buffer.alloc(headerSize + pixelsSize);

  out.write("BM", 0, "ascii");
  out.writeUInt32LE(headerSize + pixelsSize, 2);
  out.writeUInt32LE(headerSize, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(img.width, 18);
  out.writeInt32LE(img.height, 22); // positive = bottom-up rows
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(bits, 28);
  out.writeUInt32LE(0, 30); // BI_RGB
  out.writeUInt32LE(pixelsSize, 34);
  out.writeInt32LE(2835, 38); // 72 dpi
  out.writeInt32LE(2835, 42);

  for (let y = 0; y < img.height; y++) {
    const sourceRow = img.height - 1 - y;
    const rowStart = headerSize + y * rowSize;
    for (let x = 0; x < img.width; x++) {
      const src = (sourceRow * img.width + x) * 4;
      out[rowStart + x * bytesPerPixel] = img.data[src + 2];
      out[rowStart + x * bytesPerPixel + 1] = img.data[src + 1];
      out[rowStart + x * bytesPerPixel + 2] = img.data[src];
      if (bits === 32) out[rowStart + x * bytesPerPixel + 3] = img.data[src + 3];
    }
  }
  return out;
}

export function decodeBmp(buffer: Buffer): Raster {
  if (!isBmp(buffer)) throw new Error("Not a BMP: missing 'BM' header");
  const pixelOffset = buffer.readUInt32LE(10);
  const headerSize = buffer.readUInt32LE(14);
  const width = headerSize >= 40 ? buffer.readInt32LE(18) : buffer.readInt16LE(18);
  const rawHeight = headerSize >= 40 ? buffer.readInt32LE(22) : buffer.readInt16LE(22);
  const planes = buffer.readUInt16LE(26);
  const bits = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  if (planes !== 1) throw new Error(`Unsupported BMP planes=${planes}`);
  if (compression === 1 || compression === 2) throw new Error("RLE-compressed BMPs are not supported — convert to PNG instead");
  if (compression !== 0 && compression !== 3) throw new Error(`Unsupported BMP compression type ${compression}`);
  if (![1, 4, 8, 16, 24, 32].includes(bits)) throw new Error(`Unsupported BMP bit depth ${bits}`);

  const paletteEntries = buffer.readUInt32LE(32) || (bits <= 8 ? 1 << bits : 0);
  const palette: number[] = [];
  const paletteStart = 14 + Math.max(40, headerSize);
  for (let i = 0; i < paletteEntries; i++) {
    const at = paletteStart + i * 4;
    if (at + 3 >= buffer.length) break;
    palette.push(buffer[at + 2], buffer[at + 1], buffer[at], 255);
  }

  const out = createRaster(width, height);
  const rowStride = Math.ceil((width * bits) / 32) * 4;
  let masks: { r: number; g: number; b: number } | null = null;
  if (compression === 3 && headerSize >= 40) {
    masks = {
      r: buffer.readUInt32LE(54),
      g: buffer.readUInt32LE(58),
      b: buffer.readUInt32LE(62),
    };
  }
  const shiftOf = (mask: number): number => {
    let shift = 0;
    let m = mask;
    while (m && !(m & 1)) {
      m >>>= 1;
      shift++;
    }
    return shift;
  };

  for (let y = 0; y < height; y++) {
    const sourceRow = topDown ? y : height - 1 - y;
    const rowStart = pixelOffset + sourceRow * rowStride;
    if (rowStart + rowStride > buffer.length) break;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (bits <= 8) {
        const byte = buffer[rowStart + Math.floor((x * bits) / 8)];
        const mask = (1 << bits) - 1;
        const index = (byte >> (8 - bits - ((x * bits) % 8))) & mask;
        r = palette[index * 4] ?? 0;
        g = palette[index * 4 + 1] ?? 0;
        b = palette[index * 4 + 2] ?? 0;
      } else if (bits === 16) {
        const value = buffer.readUInt16LE(rowStart + x * 2);
        const mr = masks?.r ?? 0x7c00;
        const mg = masks?.g ?? 0x03e0;
        const mb = masks?.b ?? 0x001f;
        r = ((value & mr) >> shiftOf(mr)) * (255 / (mr >> shiftOf(mr) || 1));
        g = ((value & mg) >> shiftOf(mg)) * (255 / (mg >> shiftOf(mg) || 1));
        b = ((value & mb) >> shiftOf(mb)) * (255 / (mb >> shiftOf(mb) || 1));
      } else if (bits === 24) {
        b = buffer[rowStart + x * 3];
        g = buffer[rowStart + x * 3 + 1];
        r = buffer[rowStart + x * 3 + 2];
      } else {
        b = buffer[rowStart + x * 4];
        g = buffer[rowStart + x * 4 + 1];
        r = buffer[rowStart + x * 4 + 2];
        a = buffer[rowStart + x * 4 + 3];
        if (a === 0 && r + g + b > 0) a = 255; // many editors leave the alpha byte unset
      }
      const target = (y * width + x) * 4;
      out.data[target] = r;
      out.data[target + 1] = g;
      out.data[target + 2] = b;
      out.data[target + 3] = a;
    }
  }
  return out;
}
