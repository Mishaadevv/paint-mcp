import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseColor, toHex } from "../dist/core/color.js";
import { colorOf } from "../dist/core/schemas.js";
import { createRaster, rasterStats, composite, alphaBounds, getPixel } from "../dist/core/image.js";
import { encodePng, decodePng } from "../dist/core/png.js";
import { encodeBmp, decodeBmp } from "../dist/core/bmp.js";
import { decodeImage, encodeImage } from "../dist/core/format.js";
import { fillPath, strokePath, brushStroke, floodFill, solid } from "../dist/core/raster.js";
import { closedPath, openPath, parseSvgPath, rectSubpath, ellipseSubpath, roundedRectSubpath } from "../dist/core/path.js";
import { applyFilter } from "../dist/core/filter.js";
import { renderText, transliterate, measureText } from "../dist/core/font.js";
import { PaintDocument } from "../dist/core/document.js";
import { Store } from "../dist/core/store.js";
import { executeOp, OP_NAMES } from "../dist/core/execute.js";
import { documentToSvg } from "../dist/core/svg.js";

const root = path.join(tmpdir(), `paint-mcp-test-${process.pid}`);
rmSync(root, { recursive: true, force: true });

test("colour parsing covers hex, functions, names and arrays", () => {
  assert.equal(toHex(parseColor("#ff8800")), "#ff8800ff");
  assert.equal(toHex(parseColor("#f80")), "#ff8800ff");
  assert.equal(toHex(parseColor("rgb(10, 20, 30)")), "#0a141eff");
  assert.equal(toHex(parseColor("rgba(10, 20, 30, 0.5)")), "#0a141e80");
  assert.equal(toHex(parseColor("hsl(0 100% 50%)")), "#ff0000ff");
  assert.equal(toHex(parseColor("gray40")), "#666666ff");
  assert.equal(toHex(parseColor("crimson")), "#dc143cff");
  assert.equal(toHex(parseColor("h:240 s:100 l:50")), "#0000ffff");
  // what the tool schemas actually accept
  assert.equal(toHex(colorOf([1, 2, 3, 4])), "#01020304");
  assert.equal(toHex(colorOf({ r: 9, g: 8, b: 7 })), "#090807ff");
  assert.throws(() => parseColor("not-a-colour"), /Unknown color/);
});

function checkerboard(width, height) {
  const img = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const on = (x + y) % 2 === 0;
      img.data[i] = on ? 200 : 10;
      img.data[i + 1] = on ? 30 : 90;
      img.data[i + 2] = on ? 40 : 150;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

test("png round-trips alpha and truecolour", () => {
  const img = createRaster(37, 21);
  for (let i = 0; i < 37 * 21; i++) {
    img.data[i * 4] = i % 256;
    img.data[i * 4 + 1] = (i * 7) % 256;
    img.data[i * 4 + 2] = (i * 13) % 256;
    img.data[i * 4 + 3] = i % 3 === 0 ? 0 : 255;
  }
  const decoded = decodePng(encodePng(img));
  assert.equal(decoded.width, 37);
  assert.equal(decoded.height, 21);
  for (let i = 0; i < img.data.length; i++) assert.equal(decoded.data[i], img.data[i], `byte ${i}`);
});

test("png encoder drops alpha for opaque art", () => {
  const opaque = encodePng(checkerboard(16, 16));
  assert.equal(opaque[25], 2, "colour type should be 2 (truecolour)");
  const withAlpha = encodePng(createRaster(8, 8));
  assert.equal(withAlpha[25], 6, "colour type should be 6 (rgba)");
  assert.deepEqual([...decodePng(withAlpha).data].slice(0, 4), [0, 0, 0, 0]);
});

test("bmp and jpeg round-trip through the codec dispatch", () => {
  const img = checkerboard(24, 12);
  const bmp = decodeImage(encodeBmp(img));
  assert.deepEqual([bmp.width, bmp.height], [24, 12]);
  assert.equal(bmp.data[0], 200);
  const jpg = decodeImage(encodeImage(img, "jpg", { quality: 92 }));
  assert.deepEqual([jpg.width, jpg.height], [24, 12]);
  const mean = rasterStats(jpg).mean;
  assert.ok(Math.abs(mean.r - rasterStats(img).mean.r) < 20, "jpeg keeps the average colour");
  assert.throws(() => decodeImage(Buffer.from("nonsense")), /Unsupported image bytes/);
});

test("fills respect geometry and antialias edges partially", () => {
  const img = createRaster(40, 40);
  fillPath(img, closedPath(rectSubpath(10, 10, 20, 20)), solid("#00ff00"), {});
  const stats = rasterStats(img);
  assert.equal(stats.opaque_pixels, 400);
  assert.equal(alphaBounds(img).width, 20);

  const circle = createRaster(40, 40);
  fillPath(circle, closedPath(ellipseSubpath(20, 20, 12, 8)), solid("#ff0000"), {});
  const edge = [...circle.data].filter((v, i) => i % 4 === 3 && v > 0 && v < 255).length;
  assert.ok(edge > 10, `expected partially covered edge pixels, got ${edge}`);
});

test("strokes draw at the requested width with caps", () => {
  const img = createRaster(60, 20);
  strokePath(img, openPath([[10, 10], [50, 10]]), solid("#0000ff"), { width: 6, cap: "butt" });
  const column = [...Array(20).keys()].filter((y) => img.data[(y * 60 + 30) * 4 + 3] > 200).length;
  assert.ok(column >= 5 && column <= 7, `vertical ink of a 6px line was ${column}px`);
});

test("svg path parser handles curves, arcs and relative commands", () => {
  const parsed = parseSvgPath("M10 10 h20 v20 h-20 z M60 40 a10 10 0 1 0 20 0 q-10 20 -20 0");
  assert.equal(parsed.subpaths.length, 2);
  assert.ok(parsed.subpaths[1].length > 8, "arc + quad should be flattened");
  const end = parsed.subpaths[1][parsed.subpaths[1].length - 1];
  assert.ok(Math.abs(end[0] - 60) < 0.01 && Math.abs(end[1] - 40) < 0.01, `relative arc+quad should end back at (60,40), got ${end}`);
});

test("bucket fill respects tolerance and contiguity", () => {
  const img = createRaster(20, 20);
  fillPath(img, closedPath(rectSubpath(0, 0, 20, 20)), solid("#336699"), {});
  const area = floodFill(img, 5, 5, parseColor("#ff0000"), { tolerance: 0 });
  assert.equal(area.width, 20);
  assert.equal(area.height, 20);
  assert.equal(getPixel(img, 19, 19).r, 255, "far corner got filled too");

  const board = checkerboard(20, 20);
  floodFill(board, 0, 0, parseColor("#00ff00"), { tolerance: 0, contiguous: false });
  assert.equal(getPixel(board, 0, 0).g, 255, "matching squares recoloured");
  assert.equal(getPixel(board, 0, 1).r, 10, "other colour untouched");

  assert.throws(() => floodFill(img, 500, 500, solid("#fff")), /outside the 20x20 canvas/);
});

test("brush stroke paints a tapered trail", () => {
  const img = createRaster(80, 40);
  brushStroke(img, [[10, 20, 0.2], [40, 20, 1], [70, 20, 0.4]], solid("#123456"), { size: 18, hardness: 1, spacing: 0.15 });
  const bounds = alphaBounds(img);
  assert.ok(bounds && bounds.width > 60 && bounds.height > 5);
});

test("filters change pixels and invert is its own inverse", () => {
  const img = checkerboard(32, 32);
  const original = Uint8ClampedArray.from(img.data);
  applyFilter(img, "invert");
  assert.notDeepEqual(img.data, original);
  applyFilter(img, "invert");
  assert.deepEqual([...img.data], [...original]);
  const blurred = checkerboard(32, 32);
  applyFilter(blurred, "blur", { amount: 4 });
  assert.notDeepEqual([...blurred.data], [...checkerboard(32, 32).data], "blur softens the pattern");
});

test("text renders and transliterates cyrillic", () => {
  const tile = renderText("Hi!", { scale: 2, color: parseColor("#fff") });
  assert.ok(rasterStats(tile).opaque_pixels > 40);
  assert.deepEqual(measureText("AB", 3, 1), { width: 36, height: 21 });
  assert.equal(transliterate("Привет Paint"), "Privet Paint");
});

test("document layers, blend and undo history", () => {
  const doc = PaintDocument.create("unit", 30, 30, parseColor("#000000"));
  assert.equal(doc.layers.length, 2);
  const before = doc.begin("rect", [1]);
  fillPath(doc.activeLayer.raster, closedPath(rectSubpath(0, 0, 10, 10)), solid("#ff0000"), {});
  doc.commit(before);
  assert.equal(doc.undoStack.length, 1);
  assert.ok(doc.undo());
  assert.equal(rasterStats(doc.activeLayer.raster).opaque_pixels, 0, "undo cleared the ink");
  assert.ok(doc.redo());
  assert.equal(rasterStats(doc.activeLayer.raster).opaque_pixels, 100, "redo restored it");

  doc.addLayer("glow", { blend: "screen", opacity: 0.5 });
  assert.equal(doc.layers.length, 3);
  doc.mergeDown();
  assert.equal(doc.layers.length, 2);
});

test("store persists layered documents and exports images", () => {
  const store = new Store({ root, historyLimit: 5 });
  const doc = store.create("Unit Canvas", 40, 24, parseColor("#102030"));
  executeOp(store, doc, "rect", { x: 4, y: 4, width: 10, height: 10, fill: "#ff0000" }, () => {
    throw new Error("no stamps");
  });
  const file = store.saveDocument(doc);
  assert.ok(existsSync(file));
  const reloaded = store.loadFile(file);
  assert.deepEqual([reloaded.width, reloaded.height], [40, 24]);
  assert.equal(reloaded.layers.length, 2);
  const out = store.exportImage(doc, undefined, "png");
  assert.ok(existsSync(out.path) && out.bytes > 0);
  assert.equal(store.normalizeName("Unit Canvas"), "Unit Canvas");
  assert.throws(() => store.resolvePath("../escaped.png"), /outside the paint root/);
});

test("every registered op validates and reports a summary", () => {
  const store = new Store({ root: path.join(root, "ops") });
  const doc = store.create("ops", 60, 40, parseColor("#ffffff"));
  const resolve = (ref) => {
    if (ref === "sprite") return createRaster(8, 8);
    throw new Error(`unexpected source ${ref}`);
  };
  const cases = {
    rect: { x: 1, y: 1, width: 10, height: 8, fill: "#f00" },
    ellipse: { cx: 30, cy: 20, radius: 7, stroke: "#00f", stroke_width: 2 },
    line: { x1: 0, y1: 0, x2: 50, y2: 30, color: "#000", dashes: [4, 4], arrow: "end" },
    polygon: { points: [[10, 10], [20, 30], [5, 25]], fill: "#0f0" },
    path: { d: "M5 5 Q20 40 45 5", stroke: "#333", stroke_width: 3 },
    brush: { points: [[10, 10], [30, 25]], color: "#abc123", size: 6 },
    text: { text: "LABEL", x: 2, y: 2, scale: 2, color: "#000" },
    pixel_grid: { rows: ["ab", "ba"], palette: { a: "#000", b: "#fff" }, cell: 2 },
    pixels: { pixels: [{ x: 1, y: 30, color: "#123456" }, [3, 31, 0xabcdef]] },
    fill: { x: 2, y: 2, color: "#eee", tolerance: 40 },
    gradient: { type: "radial", colors: ["#fff", "#000"], area: { x: 0, y: 0, width: 30, height: 20 } },
    stamp: { source: "sprite", x: 40, y: 30, scale: 2 },
    filter: { name: "grayscale" },
    transform: { mode: "translate", x: 1, y: 1 },
    layer: { action: "add", name: "detail" },
    clear: { area: { x: 0, y: 0, width: 6, height: 6 }, color: "#ffffff" },
  };
  for (const name of OP_NAMES) {
    const params = cases[name];
    assert.ok(params, `test case missing for op ${name}`);
    const result = executeOp(store, doc, name, params, resolve);
    assert.ok(result.summary.length > 0, `${name} returned no summary`);
  }
  assert.equal(Object.keys(cases).length, OP_NAMES.length, "ops registry and test cases agree");
  assert.throws(() => executeOp(store, doc, "rect", { x: 0 }, resolve), /Invalid parameters for "rect"/);
  assert.throws(() => executeOp(store, doc, "nonsense", {}, resolve), /Unknown op/);
});

test("svg export keeps vector ops and flags raster ones", () => {
  const store = new Store({ root: path.join(root, "svg") });
  const doc = store.create("vector", 50, 40, null);
  executeOp(store, doc, "rect", { x: 2, y: 2, width: 20, height: 10, fill: { type: "linear", colors: ["#f00", "#00f"] } }, () => {
    throw new Error("unused");
  });
  executeOp(store, doc, "text", { text: "OK", x: 4, y: 20, scale: 2 }, () => {
    throw new Error("unused");
  });
  executeOp(store, doc, "brush", { points: [[1, 1], [40, 30]], color: "#000", size: 4 }, () => {
    throw new Error("unused");
  });
  const { svg, exported, skipped } = documentToSvg(doc);
  assert.match(svg, /<svg /);
  assert.match(svg, /<linearGradient/);
  assert.deepEqual(exported, ["rect", "text"]);
  assert.deepEqual(skipped, ["brush"]);
});

test("png decoder rejects junk with a helpful message", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /missing signature/);
});
