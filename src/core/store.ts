import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Raster, Rgba } from "../types.js";
import { parseColor, rgba } from "./color.js";
import { decodeImage, encodeImage, formatFromPath, SUPPORTED_FORMATS, type ImageFormat } from "./format.js";
import { composite, padRaster, rasterFilled, rasterStats, type PixelStats } from "./image.js";
import { PaintDocument, type DocumentJson } from "./document.js";

export interface StoreOptions {
  root: string;
  historyLimit?: number;
  maxPixels?: number;
  /** Write the .paint document to disk after every drawing call. */
  autoSave?: boolean;
}

export interface CanvasSummary {
  name: string;
  width: number;
  height: number;
  layers: { index: number; name: string; visible: boolean; opacity: number; blend: string }[];
  active: number;
  revision: number;
  path: string | null;
  stats: PixelStats;
}

const NAME_PATTERN = /^[\w][\w .+-]{0,63}$/;

/** In-memory canvas registry that also owns the on-disk folder layout. */
export class Store {
  readonly root: string;
  readonly historyLimit: number;
  readonly maxPixels: number;
  readonly autoSave: boolean;
  readonly allowAbsolute: boolean;
  private readonly docs = new Map<string, PaintDocument>();
  private readonly sourceFiles = new Map<string, string>();

  constructor(options: StoreOptions & { allowAbsolute?: boolean }) {
    this.root = path.resolve(options.root);
    this.historyLimit = options.historyLimit ?? 24;
    this.maxPixels = options.maxPixels ?? 40_000_000;
    this.autoSave = options.autoSave ?? false;
    this.allowAbsolute = options.allowAbsolute ?? false;
    mkdirSync(this.root, { recursive: true });
  }

  normalizeName(raw: string): string {
    const name = raw.trim().replace(/\.(paint|png|jpg|jpeg|bmp)$/i, "").replace(/[/\\]+/g, "-");
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`Canvas name "${raw}" is not usable — keep it under 64 chars, letters/digits/space/.-+ only`);
    }
    return name;
  }

  /** Resolve a user path; outside the paint root only when explicitly allowed. */
  resolvePath(ref: string): string {
    const candidate = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(this.root, ref);
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      if (this.allowAbsolute) return candidate;
      throw new Error(
        `Path "${ref}" is outside the paint root "${this.root}". Keep it inside, or start the server with --allow-absolute / PAINT_MCP_ALLOW_ABSOLUTE=1.`,
      );
    }
    return candidate;
  }

  create(name: string, width: number, height: number, background: Rgba | null = rgba(255, 255, 255)): PaintDocument {
    const key = this.normalizeName(name);
    const pixels = width * height;
    if (pixels > this.maxPixels) {
      throw new Error(`Canvas ${width}x${height} is ${pixels} pixels, above the ${this.maxPixels} limit. Use PAINT_MCP_MAX_PIXELS to raise it.`);
    }
    const doc = PaintDocument.create(key, width, height, background, this.historyLimit);
    this.docs.set(key, doc);
    return doc;
  }

  get(name: string): PaintDocument {
    const key = this.normalizeName(name);
    const doc = this.docs.get(key);
    if (doc) return doc;
    const file = this.findFile(key);
    if (file) {
      const loaded = this.loadFile(file);
      this.docs.set(key, loaded);
      this.sourceFiles.set(key, file);
      return loaded;
    }
    const known = [...this.docs.keys()];
    throw new Error(
      `No canvas named "${key}". ${known.length ? `Open ones: ${known.join(", ")}.` : "None are open yet."} Create one with paint_canvas action:'create'.`,
    );
  }

  has(name: string): boolean {
    try {
      this.get(name);
      return true;
    } catch {
      return false;
    }
  }

  private findFile(basename: string): string | null {
    const candidates = SUPPORTED_FORMATS.map((ext) => `${basename}.${ext}`).concat(`${basename}.paint`);
    const walk = (dir: string, depth: number): string | null => {
      if (depth > 3) return null;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = walk(full, depth + 1);
          if (found) return found;
          continue;
        }
        if (candidates.includes(entry.name)) return full;
      }
      return null;
    };
    return walk(this.root, 0);
  }

  list(): CanvasSummary[] {
    return [...this.docs.values()].map((doc) => this.summary(doc));
  }

  summary(doc: PaintDocument): CanvasSummary {
    return {
      name: doc.name,
      width: doc.width,
      height: doc.height,
      active: doc.activeIndex,
      revision: doc.revision,
      layers: doc.layers.map((layer, index) => ({
        index,
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
        blend: layer.blend,
      })),
      path: this.sourceFiles.get(doc.name) ?? null,
      stats: rasterStats(doc.composite()),
    };
  }

  remove(name: string): string {
    const key = this.normalizeName(name);
    if (!this.docs.delete(key)) throw new Error(`No open canvas "${key}" to close`);
    this.sourceFiles.delete(key);
    return key;
  }

  /** Paint root-relative, timestamped path for generated exports. */
  private buildPath(name: string, format: ImageFormat | "paint"): string {
    const safe = this.normalizeName(name).replace(/\s+/g, "-");
    return path.join(this.root, `${safe}.${format}`);
  }

  saveDocument(doc: PaintDocument, ref?: string): string {
    const target = ref ? this.resolvePath(ref) : this.buildPath(doc.name, "paint");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(doc.toJson()), "utf8");
    this.sourceFiles.set(doc.name, target);
    return target;
  }

  loadFile(target: string): PaintDocument {
    const buffer = readFileSync(target);
    const text = buffer.toString("utf8");
    if (text.trimStart().startsWith("{")) {
      const json = JSON.parse(text) as DocumentJson;
      const doc = PaintDocument.fromJson(json, this.historyLimit);
      if (!this.docs.has(doc.name)) doc.name = path.basename(target).replace(/\.[^.]+$/, "");
      return doc;
    }
    const image = decodeImage(buffer);
    const doc = PaintDocument.create(
      path.basename(target).replace(/\.[^.]+$/, ""),
      image.width,
      image.height,
      null,
      this.historyLimit,
    );
    const base = doc.layers[0];
    base.name = "image";
    base.raster = image;
    return doc;
  }

  openFile(ref: string, name?: string): PaintDocument {
    const target = this.resolvePath(ref);
    const doc = this.loadFile(target);
    if (name) doc.name = this.normalizeName(name);
    this.docs.set(doc.name, doc);
    this.sourceFiles.set(doc.name, target);
    return doc;
  }

  exportImage(doc: PaintDocument, ref: string | undefined, format: ImageFormat | "auto", quality?: number, flatten = true): { path: string; bytes: number; format: ImageFormat; width: number; height: number } {
    const image = flatten ? doc.composite() : doc.activeLayer.raster;
    let target = ref ? this.resolvePath(ref) : this.buildPath(doc.name, format === "auto" ? "png" : format);
    const inferred: ImageFormat = format === "auto" ? safeFormatFromPath(target) ?? "png" : format;
    if (!/\.[a-z]+$/i.test(target)) target = `${target}.${inferred}`;
    mkdirSync(path.dirname(target), { recursive: true });
    const encoded = encodeImage(image, inferred, { quality });
    writeFileSync(target, encoded);
    if (inferred === "png" || inferred === "bmp") this.sourceFiles.set(doc.name, target);
    return { path: target, bytes: encoded.length, format: inferred, width: image.width, height: image.height };
  }

  importBytes(bytes: Buffer, name: string, asLayer = false): PaintDocument {
    const image = decodeImage(bytes);
    const key = this.normalizeName(name);
    if (asLayer && this.docs.has(key)) {
      const doc = this.get(key);
      const before = doc.begin("import layer", "all");
      doc.addLayer(`${key} import`);
      doc.activeLayer.raster = image;
      doc.commit(before);
      return doc;
    }
    const doc = PaintDocument.create(key, image.width, image.height, null, this.historyLimit);
    doc.layers[0].name = "image";
    doc.layers[0].raster = image;
    this.docs.set(key, doc);
    return doc;
  }

  /** Resolve an image reference for the `stamp` op: canvas name first, then a file. */
  resolveImage(ref: string): Raster {
    const key = this.normalizeName(ref);
    if (this.docs.has(key)) return this.get(key).composite();
    const looksLikePath = ref.includes("/") || ref.includes("\\") || /\.[a-z]{2,4}$/i.test(ref);
    const target = looksLikePath ? this.resolvePath(ref) : this.findFile(key);
    if (!target) throw new Error(`Cannot find image "${ref}" — no such canvas and no matching file under ${this.root}`);
    return decodeImage(readFileSync(target));
  }

  parseBackground(value: string | null | undefined): Rgba | null {
    if (value === null) return null;
    if (value === undefined || value === "") return rgba(255, 255, 255);
    return parseColor(value);
  }

  files(): { name: string; path: string; bytes: number }[] {
    const out: { name: string; path: string; bytes: number }[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (/\.(paint|png|jpg|jpeg|bmp|svg)$/i.test(entry.name)) out.push({ name: entry.name, path: full, bytes: statSync(full).size });
      }
    };
    walk(this.root, 0);
    return out.sort((a, b) => b.bytes - a.bytes).slice(0, 40);
  }

  /** Default export destination for a canvas: <root>/<name>.<ext>. */
  exportPath(name: string, extension: string): string {
    return this.buildPath(name, extension as ImageFormat);
  }

  writeText(target: string, content: string): string {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return target;
  }

  /** Copy of the flattened canvas sitting on a solid colour. */
  flattenOnto(doc: PaintDocument, color: Rgba): Raster {
    const base = rasterFilled(doc.width, doc.height, color);
    composite(base, doc.composite());
    return base;
  }

  /** Encode an arbitrary raster (used when flattening onto a background colour). */
  exportRaster(raster: Raster, ref: string, format?: ImageFormat, quality?: number): { path: string; bytes: number; format: ImageFormat; width: number; height: number } {
    const looksLikePath = ref.includes("/") || ref.includes("\\") || /\.[a-z]{2,4}$/i.test(ref);
    const target = looksLikePath ? this.resolvePath(ref) : this.buildPath(ref, format ?? "png");
    const withExtension = /\.[a-z]+$/i.test(target) ? target : `${target}.${format ?? "png"}`;
    const inferred: ImageFormat = format ?? safeFormatFromPath(withExtension) ?? "png";
    mkdirSync(path.dirname(withExtension), { recursive: true });
    const encoded = encodeImage(raster, inferred, { quality });
    writeFileSync(withExtension, encoded);
    return { path: withExtension, bytes: encoded.length, format: inferred, width: raster.width, height: raster.height };
  }

  /** Import an image file as a new layer on an existing document. */
  importInto(doc: PaintDocument, target: string): PaintDocument {
    const image = decodeImage(readFileSync(target));
    const before = doc.begin(`import ${path.basename(target)}`, "all");
    const layer = doc.addLayer(path.basename(target).replace(/\.[^.]+$/, ""));
    layer.raster = image.width === doc.width && image.height === doc.height ? image : padRaster(image, doc.width, doc.height, "center");
    doc.commit(before);
    return doc;
  }
}

function safeFormatFromPath(target: string): ImageFormat | null {
  try {
    return formatFromPath(target);
  } catch {
    return null;
  }
}
