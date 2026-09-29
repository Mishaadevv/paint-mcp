import type { BlendMode, Raster, Rgba } from "../types.js";
import { rgba } from "./color.js";
import { cloneRaster, composite as compositeRaster, createRaster, rasterFilled } from "./image.js";
import { decodeImage, encodeImage } from "./format.js";

export const PAINT_FILE_VERSION = 1;

export interface Layer {
  name: string;
  raster: Raster;
  opacity: number;
  blend: BlendMode;
  visible: boolean;
}

export interface LayerMeta {
  name: string;
  opacity: number;
  blend: BlendMode;
  visible: boolean;
}

/** One undoable step: metadata always, pixel data only for the layers that change. */
export interface Snapshot {
  label: string;
  width: number;
  height: number;
  active: number;
  /** Length of the operation log when the snapshot was taken. */
  ops: number;
  layers: { meta: LayerMeta; data: Uint8ClampedArray | null }[];
}

export interface DocumentJson {
  format: "paint-mcp";
  version: number;
  name: string;
  width: number;
  height: number;
  active: number;
  layers: { name: string; opacity: number; blend: BlendMode; visible: boolean; image: string }[];
}

export class PaintDocument {
  name: string;
  width: number;
  height: number;
  layers: Layer[];
  active = 0;
  readonly undoStack: Snapshot[] = [];
  readonly redoStack: Snapshot[] = [];
  historyLimit: number;
  /** Every operation in order; the SVG exporter replays the vector-capable ones. */
  readonly opLog: { op: string; params: Record<string, unknown>; layer: number }[] = [];
  revision = 0;

  private constructor(
    name: string,
    width: number,
    height: number,
    layers: Layer[],
    historyLimit: number,
    active = 0,
  ) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.layers = layers;
    this.historyLimit = historyLimit;
    this.active = Math.max(0, Math.min(active, layers.length - 1));
  }

  static create(
    name: string,
    width: number,
    height: number,
    background: Rgba | null = rgba(255, 255, 255),
    historyLimit = 24,
  ): PaintDocument {
    const layers: Layer[] = [];
    if (background) {
      layers.push({
        name: "background",
        raster: rasterFilled(width, height, background),
        opacity: 1,
        blend: "normal",
        visible: true,
      });
    }
    layers.push({
      name: layers.length === 0 ? "layer 1" : "layer 2",
      raster: createRaster(width, height),
      opacity: 1,
      blend: "normal",
      visible: true,
    });
    return new PaintDocument(name, width, height, layers, historyLimit, layers.length - 1);
  }

  get activeLayer(): Layer {
    const layer = this.layers[Math.min(this.active, this.layers.length - 1)];
    if (!layer) throw new Error(`Document "${this.name}" has no layers left`);
    return layer;
  }

  get activeIndex(): number {
    return Math.min(this.active, this.layers.length - 1);
  }

  layerAt(index: number | undefined): Layer {
    if (index === undefined) return this.activeLayer;
    const layer = this.layers[index];
    if (!layer) {
      throw new Error(
        `Layer index ${index} is out of range. This document has ${this.layers.length} layer(s): ${this.describeLayers()}`,
      );
    }
    return layer;
  }

  describeLayers(): string {
    return this.layers
      .map((l, i) => `${i}:${l.name}${l.visible ? "" : "(hidden)"}${i === this.activeIndex ? "*" : ""}`)
      .join(" ");
  }

  /** Visible layers flattened bottom-to-top. */
  composite(target?: Raster): Raster {
    const out = target ?? createRaster(this.width, this.height);
    if (!target) out.data.fill(0);
    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      compositeRaster(out, layer.raster, { opacity: layer.opacity, blend: layer.blend });
    }
    return out;
  }

  snapshot(label: string, scope: "all" | number[] = "all"): Snapshot {
    const indices = scope === "all" ? this.layers.map((_, i) => i) : scope;
    return {
      label,
      width: this.width,
      height: this.height,
      active: this.active,
      ops: this.opLog.length,
      layers: this.layers.map((layer, index) => ({
        meta: { name: layer.name, opacity: layer.opacity, blend: layer.blend, visible: layer.visible },
        data: indices.includes(index) ? new Uint8ClampedArray(layer.raster.data) : null,
      })),
    };
  }

  /** Call before mutating; the returned snapshot must be passed to `commit`. */
  begin(label: string, scope: "all" | number[] = "all"): Snapshot {
    return this.snapshot(label, scope);
  }

  commit(before: Snapshot): void {
    this.undoStack.push(before);
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.revision++;
  }

  private restore(snapshot: Snapshot): void {
    this.width = snapshot.width;
    this.height = snapshot.height;
    if (this.opLog.length > snapshot.ops) this.opLog.splice(snapshot.ops);
    this.layers = snapshot.layers.map((entry, index) => {
      const existing = this.layers[index];
      const data =
        entry.data ??
        (existing && existing.raster.width === snapshot.width && existing.raster.height === snapshot.height
          ? existing.raster.data
          : new Uint8ClampedArray(snapshot.width * snapshot.height * 4));
      return {
        name: entry.meta.name,
        opacity: entry.meta.opacity,
        blend: entry.meta.blend,
        visible: entry.meta.visible,
        raster: { width: snapshot.width, height: snapshot.height, data: new Uint8ClampedArray(data) },
      };
    });
    this.active = snapshot.active;
    this.revision++;
  }

  undo(): string | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push(this.snapshot(step.label));
    this.restore(step);
    return step.label;
  }

  redo(): string | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push(this.snapshot(step.label));
    this.restore(step);
    return step.label;
  }

  history(): { label: string; undone: boolean }[] {
    return [
      ...this.undoStack.map((s) => ({ label: s.label, undone: false })),
      ...[...this.redoStack].reverse().map((s) => ({ label: s.label, undone: true })),
    ];
  }

  addLayer(name?: string, options: { opacity?: number; blend?: BlendMode; below?: boolean } = {}): Layer {
    const index = this.activeIndex + (options.below ? 0 : 1);
    const layer: Layer = {
      name: name ?? `layer ${this.layers.length + 1}`,
      raster: createRaster(this.width, this.height),
      opacity: options.opacity ?? 1,
      blend: options.blend ?? "normal",
      visible: true,
    };
    this.layers.splice(Math.max(0, Math.min(this.layers.length, index)), 0, layer);
    this.active = Math.max(0, Math.min(this.layers.length - 1, index));
    return layer;
  }

  removeLayer(index: number): void {
    if (!this.layers[index]) throw new Error(`No layer ${index}. Layers: ${this.describeLayers()}`);
    if (this.layers.length === 1) throw new Error("Cannot remove the last layer — add another one first");
    this.layers.splice(index, 1);
    this.active = Math.max(0, Math.min(this.active, this.layers.length - 1));
  }

  moveLayer(from: number, to: number): void {
    const layer = this.layers[from];
    if (!layer) throw new Error(`No layer ${from}`);
    this.layers.splice(from, 1);
    this.layers.splice(Math.max(0, Math.min(this.layers.length, to)), 0, layer);
    this.active = to;
  }

  /** Flatten `index` onto the layer underneath, then drop it. */
  mergeDown(index = this.activeIndex): void {
    if (index <= 0) throw new Error("The bottom layer has nothing below it to merge into");
    const top = this.layers[index];
    const bottom = this.layers[index - 1];
    compositeRaster(bottom.raster, top.raster, { opacity: top.opacity, blend: top.blend });
    this.layers.splice(index, 1);
    this.active = Math.max(0, Math.min(this.active, this.layers.length - 1));
  }

  resize(width: number, height: number, anchor: "center" | "top-left" = "top-left"): void {
    for (const layer of this.layers) {
      const next = createRaster(width, height);
      compositeRaster(next, layer.raster, {
        x: anchor === "center" ? Math.round((width - this.width) / 2) : 0,
        y: anchor === "center" ? Math.round((height - this.height) / 2) : 0,
      });
      layer.raster = next;
    }
    this.width = width;
    this.height = height;
  }

  clone(): PaintDocument {
    const copy = new PaintDocument(
      this.name,
      this.width,
      this.height,
      this.layers.map((l) => ({ ...l, raster: cloneRaster(l.raster) })),
      this.historyLimit,
    );
    copy.active = this.active;
    return copy;
  }

  toJson(): DocumentJson {
    return {
      format: "paint-mcp",
      version: PAINT_FILE_VERSION,
      name: this.name,
      width: this.width,
      height: this.height,
      active: this.active,
      layers: this.layers.map((layer) => ({
        name: layer.name,
        opacity: layer.opacity,
        blend: layer.blend,
        visible: layer.visible,
        image: `data:image/png;base64,${encodeImage(layer.raster, "png", { png_color: "rgba" }).toString("base64")}`,
      })),
    };
  }

  static fromJson(json: DocumentJson, historyLimit = 24): PaintDocument {
    if (json.format !== "paint-mcp") throw new Error("Not a paint-mcp document");
    if (json.version > PAINT_FILE_VERSION) {
      throw new Error(`Document version ${json.version} is newer than this server supports (${PAINT_FILE_VERSION})`);
    }
    const layers = json.layers.map((layer) => {
      const base64 = layer.image.replace(/^data:image\/png;base64,/, "");
      const raster = decodeImage(Buffer.from(base64, "base64"), "png");
      if (raster.width !== json.width || raster.height !== json.height) {
        const normalised = createRaster(json.width, json.height);
        compositeRaster(normalised, raster);
        return { ...layer, raster: normalised };
      }
      return { ...layer, raster };
    });
    const doc = new PaintDocument(json.name, json.width, json.height, layers, historyLimit);
    doc.active = Math.max(0, Math.min(json.active ?? 0, layers.length - 1));
    return doc;
  }
}
