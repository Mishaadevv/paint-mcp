#!/usr/bin/env node
/**
 * Headless showcase: builds three pictures with the engine exactly the way an
 * agent would (executeOp + paint_ops style batches) and writes PNGs you can look at.
 *
 *   node scripts/demo.mjs [output-dir]
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Store } from "../dist/core/store.js";
import { executeOp } from "../dist/core/execute.js";
import { parseColor } from "../dist/core/color.js";

const outDir = path.resolve(process.argv[2] ?? path.join("docs", "demo"));
mkdirSync(outDir, { recursive: true });
const store = new Store({ root: outDir, historyLimit: 4 });

const run = (name, ops) => {
  const background = ops.background === null ? null : parseColor(ops.background ?? "#ffffff");
  const doc = store.create(name, ops.width, ops.height, background);
  for (const step of ops.steps) {
    const { op, ...params } = step;
    executeOp(store, doc, op, params, (ref) => {
      if (store.has(ref)) return store.get(ref).composite();
      throw new Error(`demo has no image source "${ref}"`);
    });
  }
  const exported = store.exportImage(doc, undefined, "png");
  console.log(`  ${exported.path}  (${exported.bytes} bytes, ${doc.width}x${doc.height})`);
  return doc;
};

console.log("paint-mcp demo — three pictures, all drawn through the op registry:");

run("dusk-landscape", {
  width: 640,
  height: 400,
  background: null,
  steps: [
    { op: "gradient", type: "linear", from: [0, 0], to: [0, 400], colors: ["#0a1330", "#2b4d86", "#e7a45d"] },
    { op: "ellipse", cx: 430, cy: 232, radius: 46, fill: { type: "radial", radius: 90, colors: ["#ffe9a8", "#ffd16600"] } },
    { op: "ellipse", cx: 430, cy: 236, radius: 26, fill: "#fff3c4" },
    { op: "path", d: "M0 268 Q90 232 180 262 T360 258 T560 272 T640 264 L640 400 L0 400 Z", fill: "#16233d" },
    { op: "path", d: "M0 310 Q140 276 300 306 T640 300 L640 400 L0 400 Z", fill: "#0e1728" },
    { op: "pixels", pixels: Array.from({ length: 160 }, (_, i) => ({ x: (i * 97) % 640, y: (i * 53) % 190, color: "#ffffff" })) },
    { op: "path", d: "M120 400 L120 322 M120 340 L104 326 M120 348 L138 332 M150 400 L150 336", stroke: "#05080f", stroke_width: 5 },
    { op: "path", d: "M96 318 q24 -30 48 0 q-24 14 -48 0 Z", fill: "#0a1122" },
    { op: "filter", name: "vignette", amount: 55 },
    { op: "layer", action: "add", name: "type" },
    { op: "text", text: "DUSK OVER THE RIDGE", x: 28, y: 30, scale: 4, color: "#f4f7ff", outline: 1, outline_color: "#0a1330" },
    { op: "text", text: "drawn by an agent - paint-mcp", x: 28, y: 62, scale: 2, color: "#cfe0ff" },
  ],
});

run("sprite-hero", {
  width: 192,
  height: 192,
  background: "#1b1f28",
  steps: [
    {
      op: "pixel_grid",
      origin: [48, 36],
      cell: 8,
      rows: [
        "....####....",
        "...######...",
        "..########..",
        "..##.##.##..",
        "..########..",
        "...######...",
        "....#..#....",
        "...#....#...",
      ],
      palette: { "#": "#ff5d73", ".": "#00000000" },
    },
    { op: "ellipse", cx: 96, cy: 152, rx: 54, ry: 10, fill: "#00000055" },
    { op: "rect", x: 20, y: 20, width: 152, height: 152, stroke: "#4ad991", stroke_width: 3, radius: 10 },
    { op: "text", text: "SPRITE", x: 58, y: 168, scale: 3, color: "#4ad991" },
    { op: "filter", name: "pixelate", amount: 4, area: { x: 118, y: 24, width: 50, height: 50 } },
  ],
});

run("brush-study", {
  width: 420,
  height: 300,
  background: "#f7f3ea",
  steps: [
    { op: "brush", points: [[40, 220], [110, 90], [180, 210], [250, 60]], color: "#1f2d3d", size: 22, hardness: 0.35, jitter: 0.18, seed: 3 },
    { op: "brush", points: [[60, 250], [200, 250], [360, 250]], color: "#c8553d", size: 34, hardness: 0.15, flatten: 0.4, angle: 12 },
    { op: "path", d: "M300 60 c40 -30 80 10 40 40 c-40 30 -80 -10 -40 -40 z", fill: "#3d5a80", stroke: "#1b263b", stroke_width: 3 },
    { op: "line", x1: 30, y1: 30, x2: 390, y2: 30, color: "#1b263b", width: 2, dashes: [10, 6], arrow: "both" },
    { op: "text", text: "BRUSH + PATH + DASHES", x: 30, y: 44, scale: 3, color: "#1b263b" },
  ],
});

console.log(`\nopen ${outDir} to see them, or start the server with --serve 4173 for the live page.`);
