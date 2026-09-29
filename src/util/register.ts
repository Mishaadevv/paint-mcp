import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OPS, type OpDefinition } from "../core/ops.js";
import { OP_NAMES, executeOp } from "../core/execute.js";
import type { Store } from "../core/store.js";
import type { PaintDocument } from "../core/document.js";
import { buildPreview, type BuiltPreview } from "./preview.js";
import type { PreviewSetting, ServerConfig } from "./config.js";
import { FILTER_NAMES, defaultAmount } from "../core/filter.js";
import { BLEND_MODES, cropRaster, getPixel, rasterStats } from "../core/image.js";
import { PALETTE_NAMES, parseColor, toHex } from "../core/color.js";
import { documentToSvg } from "../core/svg.js";
import type { PreviewServer } from "./serve.js";

export interface Registry {
  store: Store;
  config: ServerConfig;
  preview: PreviewServer;
}

const CanvasArg = z
  .string()
  .min(1)
  .max(64)
  .describe("Canvas name. Letters, digits, space, dot, dash, plus; the .png/.paint suffix may be included or omitted.");

const PreviewArg = z
  .enum(["auto", "none", "thumb", "full"])
  .optional()
  .describe("Image reply: auto/thumb = downscaled picture back into the result, full = unpixelated, none = text only");

const PreviewSizeArg = z.number().int().min(32).max(4096).optional().describe("Longest edge of the returned thumbnail");

const RegionArg = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
  })
  .optional()
  .describe("Crop the reply to this rectangle");

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function reply(text: string, structured: Record<string, unknown>, preview?: BuiltPreview): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text }];
  if (preview?.content) content.push(preview.content);
  return { content, structuredContent: structured };
}

function canvasState(doc: PaintDocument): Record<string, unknown> {
  return {
    canvas: doc.name,
    width: doc.width,
    height: doc.height,
    active_layer: doc.activeIndex,
    layers: doc.layers.map((layer, index) => ({ index, name: layer.name, visible: layer.visible, opacity: layer.opacity, blend: layer.blend })),
    revision: doc.revision,
    undo_steps: doc.undoStack.length,
    redo_steps: doc.redoStack.length,
  };
}

function imageOf(doc: PaintDocument, layerOnly: boolean | undefined): ReturnType<typeof doc.composite> {
  return layerOnly ? doc.activeLayer.raster : doc.composite();
}

function shapeOf(definition: OpDefinition): ZodRawShapeCompat {
  return (definition.schema as unknown as z.ZodObject<z.ZodRawShape>).shape as unknown as ZodRawShapeCompat;
}

/** Drawing tools are generated from the op registry, so docs and behaviour never drift apart. */
function registerOpTool(server: McpServer, registry: Registry, name: string, definition: OpDefinition): void {
  const shape: ZodRawShapeCompat = {
    canvas: CanvasArg,
    preview: PreviewArg,
    preview_size: PreviewSizeArg,
    ...shapeOf(definition),
  };
  const handler = (raw: Record<string, unknown>): CallToolResult => {
    try {
      const { canvas, preview, preview_size, ...params } = raw;
      const doc = registry.store.get(String(canvas));
      const result = executeOp(registry.store, doc, name, params, (ref) => registry.store.resolveImage(ref));
      const image = buildPreview(
        doc.composite(),
        { preview: preview as PreviewSetting, size: preview_size as number | undefined },
        registry.config,
      );
      const text = [
        `${name} · ${result.summary}`,
        `canvas "${doc.name}" ${doc.width}x${doc.height} · layer ${result.layer} "${doc.layers[result.layer]?.name}" · rev ${doc.revision}`,
        image.note ? image.note : "",
      ]
        .filter(Boolean)
        .join("\n");
      return reply(text, { ...canvasState(doc), op: result.op, summary: result.summary, preview: image.mode, preview_size: [image.width, image.height] }, image);
    } catch (error) {
      return fail(error);
    }
  };
  server.registerTool(
    `paint_${name}`,
    {
      title: `Paint: ${definition.title}`,
      description: `${definition.description}\n\nTarget the canvas by name (created with paint_canvas) and optionally a layer index. Layers, filters and undo work the same for every drawing tool.`,
      inputSchema: shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: definition.destructive === true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handler as unknown as ToolCallback<typeof shape>,
  );
}

export function registerTools(server: McpServer, registry: Registry): string[] {
  const names: string[] = [];

  server.registerTool(
    "paint_canvas",
    {
      title: "Paint: canvas lifecycle",
      description: `Create, list, inspect, open, save or close canvases.

Actions:
  create  {name, width, height, background}   new canvas; background is a colour or null for transparent. Layers start as ["background"? , "layer N"].
  info    {name}                              size, layers, active index, undo depth, pixel statistics
  list    {}                                  every open canvas
  open    {path}                              load a .paint / png / jpg / bmp file from the paint root
  save    {name, path?}                       write the layered .paint document
  close   {name}                              drop it from memory (files stay on disk)
  files   {}                                  what is on disk in the paint root
  history {name}                              undo/redo stack labels

A canvas must be created (or opened) before any drawing tool can be used.`,
      inputSchema: z.strictObject({
        action: z.enum(["create", "info", "list", "open", "save", "close", "files", "history"]),
        canvas: CanvasArg.optional(),
        width: z.number().int().min(1).max(8000).optional().describe("Canvas width in pixels (create)"),
        height: z.number().int().min(1).max(8000).optional().describe("Canvas height in pixels (create)"),
        background: z.union([z.string(), z.null()]).optional().describe("Fill colour for the bottom layer, or null for transparent"),
        path: z.string().optional().describe("File path for open/save, relative to the paint root unless allowed"),
        preview: PreviewArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const { action, canvas, width, height, background, path, preview } = args;
        switch (action) {
          case "create": {
            if (!canvas || !width || !height) throw new Error("create needs canvas, width and height");
            const doc = registry.store.create(canvas, width, height, registry.store.parseBackground(background));
            const image = buildPreview(doc.composite(), { preview }, registry.config);
            return reply(
              `created "${doc.name}" ${doc.width}x${doc.height} with ${doc.describeLayers()}\nDraw onto it with paint_rect / paint_brush / paint_ops; add layers with paint_layer.`,
              { ...canvasState(doc) },
              image,
            );
          }
          case "list": {
            const list = registry.store.list();
            if (list.length === 0) return reply("No open canvases. Create one: paint_canvas action:'create' canvas:'art' width:640 height:400", { canvases: [] });
            const text = list.map((doc) => `- ${doc.name} ${doc.width}x${doc.height} · ${doc.layers.length} layer(s) · active ${doc.active} · rev ${doc.revision} · ${doc.stats.opaque_pixels} painted px`).join("\n");
            return reply(text, { canvases: list });
          }
          case "info": {
            if (!canvas) throw new Error("info needs canvas");
            const doc = registry.store.get(canvas);
            const summary = registry.store.summary(doc);
            const image = buildPreview(doc.composite(), { preview }, registry.config);
            return reply(
              `"${doc.name}" ${doc.width}x${doc.height}\nlayers: ${doc.describeLayers()}\npainted ${summary.stats.opaque_pixels} px · undo ${doc.undoStack.length} · redo ${doc.redoStack.length}`,
              { ...canvasState(doc), stats: summary.stats, path: summary.path },
              image,
            );
          }
          case "open": {
            if (!path) throw new Error("open needs path");
            const doc = registry.store.openFile(path);
            const image = buildPreview(doc.composite(), { preview }, registry.config);
            return reply(`opened ${path} as "${doc.name}" ${doc.width}x${doc.height}`, canvasState(doc), image);
          }
          case "save": {
            if (!canvas) throw new Error("save needs canvas");
            const doc = registry.store.get(canvas);
            const target = registry.store.saveDocument(doc, path);
            return reply(`saved ${target}`, { path: target, ...canvasState(doc) });
          }
          case "close": {
            if (!canvas) throw new Error("close needs canvas");
            return reply(`closed "${registry.store.remove(canvas)}"`, { closed: canvas });
          }
          case "files": {
            const files = registry.store.files();
            return reply(files.length ? files.map((f) => `- ${f.name} (${f.bytes} bytes)`).join("\n") : `No files under ${registry.store.root} yet`, { root: registry.store.root, files });
          }
          case "history": {
            if (!canvas) throw new Error("history needs canvas");
            const doc = registry.store.get(canvas);
            const steps = doc.history();
            return reply(steps.length ? steps.map((s, i) => `${i + 1}. ${s.label}${s.undone ? " (redoable)" : ""}`).join("\n") : "Nothing to undo yet", { history: steps });
          }
        }
      } catch (error) {
        return fail(error);
      }
    },
  );
  names.push("paint_canvas");

  server.registerTool(
    "paint_ops",
    {
      title: "Paint: batch of operations",
      description: `Run many drawing operations in ONE call and get ONE picture back — the cheapest way to build a whole scene.

ops is a list of {op: "<name>", ...that op's parameters}. Available ops: ${OP_NAMES.join(", ")}. Every op also exists as its own tool (paint_rect, paint_brush, …) with the same fields.
Optional per-item "layer" picks the layer; add layers first with paint_layer or inline via {op:"layer", action:"add"}.

Example:
  ops: [
    {op:"gradient", type:"linear", colors:["#0b1d3a","#3b6fb5"]},
    {op:"ellipse", cx:600, cy:120, radius:46, fill:"#ffe27a"},
    {op:"path", d:"M0 300 L120 220 L260 300 Z", fill:"#233"},
    {op:"text", text:"NIGHT RUN", x:320, y:40, scale:6, color:"#fff"}
  ]

Returns a summary line per operation plus one preview of the result. Undo rolls back the whole batch step by step.`,
    inputSchema: z.strictObject({
      canvas: CanvasArg,
      ops: z.array(z.record(z.string(), z.unknown())).min(1).max(400).describe("Ordered list of {op, …params}"),
      stop_on_error: z.boolean().default(true).describe("Abort at the first failing op (already-applied ops stay)"),
      preview: PreviewArg,
      preview_size: PreviewSizeArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const doc = registry.store.get(args.canvas);
        const lines: string[] = [];
        const results: { op: string; summary: string }[] = [];
        let failed: string | null = null;
        for (const [index, item] of args.ops.entries()) {
          const name = typeof item.op === "string" ? item.op : undefined;
          if (!name) {
            failed = `item ${index} has no "op" field`;
            break;
          }
          const { op: _drop, ...params } = item;
          try {
            const result = executeOp(registry.store, doc, name, params, (ref) => registry.store.resolveImage(ref));
            results.push({ op: name, summary: result.summary });
            lines.push(`${index + 1}. ${name}: ${result.summary}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lines.push(`${index + 1}. ${name} FAILED: ${message}`);
            if (args.stop_on_error) {
              failed = message;
              break;
            }
          }
        }
        const image = buildPreview(doc.composite(), { preview: args.preview, size: args.preview_size }, registry.config);
        const head = failed
          ? `${results.length}/${args.ops.length} operation(s) applied, stopped: ${failed}`
          : `${results.length} operation(s) applied on "${doc.name}" (${doc.width}x${doc.height}, rev ${doc.revision})`;
        return reply([head, ...lines].join("\n"), {
          ...canvasState(doc),
          applied: results,
          failed,
          preview: image.mode,
          preview_size: [image.width, image.height],
        }, image);
      } catch (error) {
        return fail(error);
      }
    },
  );
  names.push("paint_ops");

  server.registerTool(
    "paint_preview",
    {
      title: "Paint: look at the canvas",
      description:
        "Return the current picture without changing anything — use it to check your work, compare against a reference, or re-read a canvas after a long session. Set layer:true to see only the active layer.",
      inputSchema: z.strictObject({
        canvas: CanvasArg,
        preview: z.enum(["auto", "thumb", "full"]).default("auto"),
        preview_size: PreviewSizeArg,
        region: RegionArg,
        layer: z.boolean().default(false).describe("Show only the active layer instead of the flattened canvas"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const doc = registry.store.get(args.canvas);
        const raster = imageOf(doc, args.layer);
        const image = buildPreview(raster, { preview: args.preview, size: args.preview_size, region: args.region }, registry.config);
        const stats = rasterStats(args.region ? raster : doc.composite());
        return reply(
          `"${doc.name}" ${doc.width}x${doc.height} · layer ${doc.activeIndex} "${doc.activeLayer.name}" · rev ${doc.revision}\n${stats.opaque_pixels} painted px, dominant ${stats.dominant.map((d) => `${d.hex} ${(d.share * 100).toFixed(0)}%`).join(", ")}`,
          { ...canvasState(doc), stats },
          image,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
  names.push("paint_preview");

  server.registerTool(
    "paint_inspect",
    {
      title: "Paint: read pixels",
      description:
        "Ask exact questions about the picture: colour at points, statistics and bounding box of painted pixels, or a colour histogram of a region. Cheaper than a thumbnail when you only need numbers.",
      inputSchema: z.strictObject({
        canvas: CanvasArg,
        points: z.array(z.array(z.number().int()).min(2).max(2)).max(256).optional().describe("[x,y] pairs to read the colour of"),
        region: RegionArg,
        layer: z.boolean().default(false).describe("Inspect one layer instead of the flattened canvas"),
        top: z.number().int().min(1).max(24).default(6).describe("How many dominant colours to report"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const doc = registry.store.get(args.canvas);
        const raster = imageOf(doc, args.layer);
        const pixels = (args.points ?? []).map(([x, y]) => {
          const color = getPixel(raster, Math.round(x), Math.round(y));
          return { x, y, hex: toHex(color), rgba: [color.r, color.g, color.b, color.a] };
        });
        const target = args.region ? cropRaster(raster, args.region.x, args.region.y, args.region.width, args.region.height) : raster;
        const stats = rasterStats(target, args.top);
        const lines = [
          `"${doc.name}" ${doc.width}x${doc.height}, ${args.region ? `region ${args.region.width}x${args.region.height}` : "whole canvas"}`,
          `painted ${stats.opaque_pixels} px / transparent ${stats.transparent_pixels} px`,
          stats.bounds ? `content bounds ${stats.bounds.x},${stats.bounds.y} ${stats.bounds.width}x${stats.bounds.height}` : "no painted pixels at all",
          `dominant: ${stats.dominant.map((d) => `${d.hex}(${(d.share * 100).toFixed(1)}%)`).join(" ")}`,
          ...pixels.map((p) => `pixel (${p.x},${p.y}) = ${p.hex}`),
        ];
        return reply(lines.join("\n"), { ...canvasState(doc), pixels, stats });
      } catch (error) {
        return fail(error);
      }
    },
  );
  names.push("paint_inspect");

  server.registerTool(
    "paint_undo",
    {
      title: "Paint: undo / redo",
      description:
        "Roll a canvas back or forward. Each drawing operation is one step (a paint_ops batch rolls back one step per op). Use action:'steps' to see the stack without changing anything.",
      inputSchema: z.strictObject({
        canvas: CanvasArg,
        action: z.enum(["undo", "redo", "steps"]).default("undo"),
        steps: z.number().int().min(1).max(200).default(1).describe("How many steps to roll back or forward"),
        preview: PreviewArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const doc = registry.store.get(args.canvas);
        if (args.action === "steps") {
          const steps = doc.history();
          return reply(steps.length ? steps.map((s, i) => `${i + 1}. ${s.label}${s.undone ? " (redoable)" : ""}`).join("\n") : "History is empty", { history: steps });
        }
        const done: string[] = [];
        for (let i = 0; i < args.steps; i++) {
          const label = args.action === "undo" ? doc.undo() : doc.redo();
          if (!label) break;
          done.push(label);
        }
        const image = buildPreview(doc.composite(), { preview: args.preview }, registry.config);
        return reply(
          done.length ? `${args.action} ${done.length} step(s): ${done.join(", ")}\nnow at rev ${doc.revision}` : `Nothing to ${args.action}`,
          { ...canvasState(doc), undone: done },
          image,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
  names.push("paint_undo");

  server.registerTool(
    "paint_export",
    {
      title: "Paint: export a file",
      description:
        `Write the canvas out: png, jpg, bmp, svg (rebuilt from recorded vector operations) or .paint (layered, re-openable). Returns the path under the paint root plus a preview of exactly what was written.

svg keeps rect/ellipse/line/polygon/path/text/gradient operations; raster-only steps (brush, fill, pixels, filters, stamps) cannot be vectorised and are reported. Set embed_raster_fallback to also place the current PNG behind them.`,
      inputSchema: z.strictObject({
        canvas: CanvasArg,
        format: z.enum(["png", "jpg", "jpeg", "bmp", "svg", "paint", "auto"]).default("auto").describe("auto = png unless path says otherwise"),
        path: z.string().optional().describe("Target path relative to the paint root; omit to use the canvas name"),
        flatten: z.boolean().default(true).describe("true = whole canvas, false = active layer only (raster formats)"),
        quality: z.number().int().min(1).max(100).optional().describe("jpeg quality or png deflate effort"),
        background: z.string().nullable().optional().describe("Colour to flatten onto, e.g. '#ffffff'; null keeps transparency"),
        embed_raster_fallback: z.boolean().default(false).describe("svg only: embed the current picture underneath the vector shapes"),
        preview: PreviewArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const doc = registry.store.get(args.canvas);
        if (args.format === "svg") {
          const svg = documentToSvg(doc, { background: typeof args.background === "string" ? args.background : undefined, embedRasterFallback: args.embed_raster_fallback });
          const target = args.path ? registry.store.resolvePath(args.path) : registry.store.exportPath(doc.name, "svg");
          const written = registry.store.writeText(target, svg.svg);
          const head = svg.skipped.length
            ? `svg written, but ${svg.skipped.length} raster-only step(s) have no vector form: ${svg.skipped.join(", ")}`
            : `svg written with ${svg.exported.length} vector shape(s)`;
          return reply(`${head}\n${written}`, { path: written, exported: svg.exported, skipped: svg.skipped, bytes: svg.svg.length });
        }
        if (args.format === "paint") {
          const written = registry.store.saveDocument(doc, args.path);
          return reply(`layered document written\n${written}`, { path: written, layers: doc.layers.length });
        }
        if (args.background !== undefined && args.background !== null) {
          const flat = registry.store.flattenOnto(doc, parseColor(args.background));
          const out = registry.store.exportRaster(flat, args.path ?? doc.name, args.format === "auto" ? undefined : args.format, args.quality);
          return reply(`exported ${out.path} (${out.bytes} bytes, ${out.format})`, { ...out });
        }
        const out = registry.store.exportImage(doc, args.path, args.format === "auto" ? "auto" : args.format, args.quality, args.flatten);
        const image = buildPreview(
          args.flatten ? doc.composite() : doc.activeLayer.raster,
          { preview: args.preview ?? "auto" },
          registry.config,
        );
        return reply(`exported ${out.path}\n${out.bytes} bytes · ${out.format} · ${out.width ?? doc.width}x${out.height ?? doc.height}`, { ...out, ...canvasState(doc) }, image);
      } catch (error) {
        return fail(error);
      }
    },
  );
  names.push("paint_export");

  server.registerTool(
    "paint_import",
    {
      title: "Paint: import an image",
      description:
        "Bring a picture in: `path` for a file under the paint root (png/jpg/bmp, real format is sniffed from the bytes), or `data` with base64 when the agent already holds the bytes. Creates a canvas, or adds a layer when the target canvas exists.",
      inputSchema: z.strictObject({
        path: z.string().optional().describe("Image or .paint file, relative to the paint root unless absolute paths are allowed"),
        data: z.string().optional().describe("Base64 (or data:…;base64,) image bytes"),
        canvas: CanvasArg.optional().describe("Name for the new canvas, or the existing canvas to receive a layer"),
        as_layer: z.boolean().default(false).describe("Add to an existing canvas instead of creating a new one"),
        preview: PreviewArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.path && !args.data) throw new Error("paint_import needs either path or data");
        let doc: PaintDocument;
        if (args.data) {
          const base64 = args.data.replace(/^data:[^;]+;base64,/, "");
          doc = registry.store.importBytes(Buffer.from(base64, "base64"), args.canvas ?? "imported", args.as_layer);
        } else if (args.as_layer && args.canvas) {
          const target = registry.store.get(args.canvas);
          doc = registry.store.importInto(target, registry.store.resolvePath(String(args.path)));
        } else {
          doc = registry.store.openFile(String(args.path), args.canvas);
        }
        const image = buildPreview(doc.composite(), { preview: args.preview }, registry.config);
        return reply(`imported into "${doc.name}" ${doc.width}x${doc.height} · ${doc.describeLayers()}`, canvasState(doc), image);
      } catch (error) {
        return fail(error);
      }
    },
  );
  names.push("paint_import");

  server.registerTool(
    "paint_help",
    {
      title: "Paint: reference card",
      description:
        "In-server documentation, no round trip to GitHub. Topics: ops (every operation and its fields), colors (formats and the named palette), blend, filters, svg, limits, workflow (how to plan a drawing), examples (copy-paste batches).",
      inputSchema: z.strictObject({
        topic: z.enum(["all", "ops", "colors", "blend", "filters", "svg", "limits", "workflow", "examples"]).default("all"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const topics: Record<string, string> = {
        ops: Object.entries(OPS)
          .map(([name, def]) => `paint_${name} — ${def.title}\n  ${def.description}`)
          .join("\n\n"),
        colors: `Accepted colours: "#rgb", "#rrggbb", "#rrggbbaa", "rgb(10,20,30)", "rgba(…)", "hsl(210 80% 50%)", "h:210 s:80 l:50", "gray40", ${PALETTE_NAMES.length} named colours (${PALETTE_NAMES.slice(0, 40).join(", ")} …), or [r,g,b(,a)] / {r,g,b,a}.\nGradients: {type:"linear"|"radial", from:[x,y], to:[x,y], radius, colors:[…]} or stops:[{at:0,color:"#000"},{at:1,color:"#fff"}].`,
        blend: `Blend modes: ${BLEND_MODES.join(", ")}. multiply/screen/overlay for shading and light, dodge/burn for highlights, difference/exclusion for alignment checks, add/subtract for glow. Each drawing tool takes blend + opacity.`,
        filters: FILTER_NAMES.map((name) => `- ${name}: default amount ${defaultAmount(name)}`).join("\n"),
        svg: "paint_export format:'svg' rebuilds recorded vector ops (rect, ellipse, line, polygon, path, text, gradient). Raster steps (brush, fill, pixels, filter, stamp, clear, transform, pixel_grid) cannot be vectorised and are listed in the reply.",
        limits: `Canvas: ${registry.config.maxPixels / 1_000_000}MP max, 8000px per side. Undo history: ${registry.config.historyLimit} steps. Files live under ${registry.config.root}. paint_ops takes up to 400 operations per call.`,
        workflow: `1. paint_canvas create (pick a size you can reason about, e.g. 640x400).\n2. Block the composition early: background gradient, big shapes, silhouettes. Use paint_ops so the whole plan is one call.\n3. Look at the reply image. Fix with targeted ops (paint_clear + redraw, or paint_layer to isolate a mistake).\n4. Details last: thin lines, highlights, text labels.\n5. paint_export. Keep aspect ratio in mind; scale/rotate live in paint_transform.`,
        examples: `Sky + hills + sun:
  ops:[{op:"gradient",type:"linear",from:[0,0],to:[0,400],colors:["#0b1d3a","#5c86c9"]},
       {op:"ellipse",cx:520,cy:90,radius:38,fill:"#ffe27a"},
       {op:"path",d:"M0 300 Q160 240 320 300 T640 290 L640 400 L0 400 Z",fill:"#1b3a2a"},
       {op:"text",text:"DUSK",x:24,y:28,scale:5,color:"#fff",outline:1,outline_color:"#000"}]

Pixel-art heart (12x11):
  ops:[{op:"pixel_grid",origin:[10,10],cell:8,rows:[".##....##..","##########","##########",".########.","..####..","...##..."],palette:{"#":"#e0356b",".":"#0000"}}]

Sprite then scaled up:
  ops:[{op:"pixel_grid",...},{op:"transform",mode:"scale",factor:2,layer:1}]`,
      };
      const body = args.topic === "all" ? Object.values(topics).join("\n\n---\n\n") : topics[args.topic];
      return reply(body, { topic: args.topic, characters: body.length });
    },
  );
  names.push("paint_help");

  server.registerTool(
    "paint_serve",
    {
      title: "Paint: live preview page",
      description:
        "Start/stop a localhost page that shows every open canvas and repaints once a second, so a human can watch the drawing happen. Only 127.0.0.1 is bound. action:'status' reports the URL.",
      inputSchema: z.strictObject({
        action: z.enum(["start", "stop", "status"]).default("start"),
        port: z.number().int().min(1024).max(65535).optional().describe("Default 4173, or --serve at startup"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const port = args.port ?? registry.config.servePort ?? 4173;
      if (args.action === "stop") {
        return reply(registry.preview.stop() ? "live preview stopped" : "live preview was not running", { running: false });
      }
      if (args.action === "status") {
        return reply(registry.preview.running ? `running at ${registry.preview.url}` : "not running", { running: registry.preview.running, url: registry.preview.url });
      }
      const url = registry.preview.start(port);
      return reply(`live preview at ${url} — refreshes once per second`, { running: true, url });
    },
  );
  names.push("paint_serve");

  if (registry.config.toolset !== "compact") {
    for (const [name, definition] of Object.entries(OPS)) {
      registerOpTool(server, registry, name, definition);
      names.push(`paint_${name}`);
    }
  }

  return names;
}
