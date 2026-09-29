import { inflateSync, deflateSync } from "node:zlib";
import type { Raster } from "../types.js";
import { createRaster } from "./image.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(new Uint8Array(crcInput)), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export interface PngEncodeOptions {
  /** deflate level 0..9 (default 6) */
  level?: number;
  /** `auto` drops the alpha channel when every pixel is opaque. */
  color?: "auto" | "rgba" | "rgb";
}

/** Encode an RGBA raster as a PNG buffer. Truecolour, adaptive filtering, no deps. */
export function encodePng(img: Raster, options: PngEncodeOptions = {}): Buffer {
  let allOpaque = true;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) {
      allOpaque = false;
      break;
    }
  }
  const mode = options.color ?? "auto";
  const withAlpha = mode === "rgba" || (mode === "auto" && !allOpaque);
  const channels = withAlpha ? 4 : 3;
  const colorType = withAlpha ? 6 : 2;
  const stride = img.width * channels;
  const raw = Buffer.alloc((stride + 1) * img.height);
  let previousRow: Buffer | null = null;

  for (let y = 0; y < img.height; y++) {
    const rowStart = y * (stride + 1) + 1;
    const rowBytes = Buffer.alloc(stride);
    for (let x = 0; x < img.width; x++) {
      const src = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) rowBytes[x * channels + c] = img.data[src + c];
      if (withAlpha) rowBytes[x * channels + 3] = img.data[src + 3];
    }

    // PNG filters are defined over the *unfiltered* neighbours, so a/b/c come
    // from the pristine row and the pristine row above, never from encoded bytes.
    const applyFilter = (filter: number, target: Buffer): void => {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? rowBytes[i - channels] : 0;
        const b = previousRow ? previousRow[i] : 0;
        const c = previousRow && i >= channels ? previousRow[i - channels] : 0;
        let prediction = 0;
        switch (filter) {
          case 1:
            prediction = a;
            break;
          case 2:
            prediction = b;
            break;
          case 3:
            prediction = (a + b) >> 1;
            break;
          case 4:
            prediction = paeth(a, b, c);
            break;
          default:
            prediction = 0;
        }
        target[i] = (rowBytes[i] - prediction) & 0xff;
      }
    };

    const filtered = Buffer.alloc(stride);
    let bestFilter = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      applyFilter(filter, filtered);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const v = filtered[i];
        score += v > 127 ? 256 - v : v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
      }
    }
    applyFilter(bestFilter, filtered);
    raw[rowStart - 1] = bestFilter;
    filtered.copy(raw, rowStart);
    previousRow = rowBytes;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", new Uint8Array(ihdr)),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: options.level ?? 6 }))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

interface PngChunk {
  type: string;
  data: Buffer;
}

function readChunks(buffer: Buffer): { chunks: PngChunk[]; ihdr: { width: number; height: number; depth: number; color: number; interlace: number } } {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("Not a PNG: missing signature (is this really a .png file?)");
  }
  let offset = 8;
  const chunks: PngChunk[] = [];
  let ihdr: { width: number; height: number; depth: number; color: number; interlace: number } | null = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    }
    chunks.push({ type, data: Buffer.from(data) });
    if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!ihdr) throw new Error("Not a PNG: no IHDR chunk found");
  return { chunks, ihdr };
}

export function isPng(buffer: Uint8Array): boolean {
  return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

/** Decode a PNG buffer into an RGBA raster. Handles grey/palette/RGB/RGBA, 1–16 bit. */
export function decodePng(buffer: Buffer): Raster {
  const { chunks, ihdr } = readChunks(buffer);
  if (ihdr.interlace !== 0) throw new Error("Interlaced (Adam7) PNGs are not supported — re-export without interlacing");
  const { width, height, depth, color } = ihdr;
  if (depth !== 1 && depth !== 2 && depth !== 4 && depth !== 8 && depth !== 16) {
    throw new Error(`Unsupported PNG bit depth ${depth}`);
  }
  const channelsOf = (type: number): number => {
    switch (type) {
      case 0:
        return 1;
      case 2:
        return 3;
      case 3:
        return 1;
      case 4:
        return 2;
      case 6:
        return 4;
      default:
        throw new Error(`Unsupported PNG colour type ${color}`);
    }
  };
  const channels = channelsOf(color);
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  if (idat.length === 0) throw new Error("PNG has no image data");
  const raw = inflateSync(new Uint8Array(idat));
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error(`Truncated PNG: got ${raw.length} bytes, expected ${expected}`);

  const paletteChunk = chunks.find((c) => c.type === "PLTE")?.data;
  const transparency = chunks.find((c) => c.type === "tRNS")?.data;

  // Unfilter row by row.
  const bytesPerPixel = Math.ceil(bitsPerPixel / 8);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y === 0 ? null : rows[y - 1];
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
      const value = line[i];
      let result: number;
      switch (filter) {
        case 1:
          result = value + a;
          break;
        case 2:
          result = value + b;
          break;
        case 3:
          result = value + ((a + b) >> 1);
          break;
        case 4:
          result = value + paeth(a, b, c);
          break;
        case 0:
          result = value;
          break;
        default:
          throw new Error(`Unknown PNG filter ${filter} on row ${y}`);
      }
      row[i] = result & 0xff;
    }
    rows.push(row);
  }

  /** `sample` is the index in the interleaved channel stream of one scanline. */
  const readSample = (row: Uint8Array, sample: number): number => {
    if (depth === 8) return row[sample];
    if (depth === 16) return row[sample * 2]; // high byte: 8-bit output is plenty for painting
    const bit = sample * depth;
    const mask = (1 << depth) - 1;
    const value = (row[Math.floor(bit / 8)] >> (8 - depth - (bit % 8))) & mask;
    return Math.round((value / mask) * 255);
  };

  const image = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (color === 3) {
        const index = readSample(row, x);
        if (!paletteChunk) throw new Error("Palette PNG without a PLTE chunk");
        r = paletteChunk[index * 3];
        g = paletteChunk[index * 3 + 1];
        b = paletteChunk[index * 3 + 2];
        if (transparency && index < transparency.length) a = transparency[index];
      } else if (color === 0 || color === 4) {
        const grey = readSample(row, x * channels);
        r = g = b = grey;
        if (color === 4) a = readSample(row, x * 2 + 1);
        if (color === 0 && transparency && transparency.length >= 2) {
          const key = depth === 16 ? transparency.readUInt16BE(0) : transparency.readUInt16BE(0) >> 8;
          if (grey === key) a = 0;
        }
      } else if (color === 2) {
        r = readSample(row, x * 3);
        g = readSample(row, x * 3 + 1);
        b = readSample(row, x * 3 + 2);
        if (transparency && transparency.length >= 6) {
          const key = (offset: number): number =>
            depth === 16 ? transparency.readUInt16BE(offset) : transparency.readUInt16BE(offset) >> 8;
          if (r === key(0) && g === key(2) && b === key(4)) a = 0;
        }
      } else {
        r = readSample(row, x * 4);
        g = readSample(row, x * 4 + 1);
        b = readSample(row, x * 4 + 2);
        a = readSample(row, x * 4 + 3);
      }
      const target = (y * width + x) * 4;
      image.data[target] = r;
      image.data[target + 1] = g;
      image.data[target + 2] = b;
      image.data[target + 3] = a;
    }
  }
  return image;
}
