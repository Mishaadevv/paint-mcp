import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decodePng } from "../dist/core/png.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "dist", "index.js");
const root = mkdtempSync(path.join(tmpdir(), "paint-mcp-server-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, "--root", root, "--preview", "thumb", "--preview-size", "200"],
});
const client = new Client({ name: "paint-integration-test", version: "1.0.0" });

after(async () => {
  await client.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { result, text, structured: result.structuredContent ?? {} };
};

test("handshake advertises the paint tool surface", async () => {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.length >= 24, `expected one tool per op plus utilities, got ${names.length}`);
  for (const required of ["paint_canvas", "paint_ops", "paint_preview", "paint_export", "paint_help", "paint_brush", "paint_pixel_grid"]) {
    assert.ok(names.includes(required), `${required} missing`);
  }
  for (const tool of tools) {
    assert.ok(tool.description?.length > 20, `${tool.name} has no usable description`);
    assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
  }
});

test("create → batch draw → look → undo → export", async () => {
  const created = await call("paint_canvas", {
    action: "create",
    canvas: "integration",
    width: 120,
    height: 90,
    background: "#101820",
  });
  assert.match(created.text, /created "integration" 120x90/);
  assert.equal(created.structured.width, 120);
  assert.equal(created.result.content.some((c) => c.type === "image"), true, "create should return a picture");

  const drawn = await call("paint_ops", {
    canvas: "integration",
    ops: [
      { op: "gradient", type: "linear", from: [0, 0], to: [0, 90], colors: ["#274060", "#f2e3c6"] },
      { op: "rect", x: 10, y: 20, width: 30, height: 20, fill: "#e0533d" },
      { op: "ellipse", cx: 90, cy: 30, radius: 12, fill: "#ffd166" },
      { op: "text", text: "OK", x: 8, y: 60, scale: 3, color: "#ffffff" },
    ],
  });
  assert.match(drawn.text, /4 operation\(s\) applied/);
  assert.equal(drawn.structured.applied.length, 4);

  const preview = await call("paint_preview", { canvas: "integration" });
  const image = preview.result.content.find((c) => c.type === "image");
  assert.ok(image, "preview returned no image block");
  const decoded = decodePng(Buffer.from(image.data, "base64"));
  assert.deepEqual([decoded.width, decoded.height], [120, 90], "small canvases are returned at full size");
  assert.ok(decoded.data[3] > 200, "top-left pixel is painted, not transparent");

  const large = await call("paint_ops", {
    canvas: "integration",
    ops: [{ op: "layer", action: "add", name: "wide" }],
    preview: "thumb",
    preview_size: 60,
  });
  assert.equal(large.structured.preview_size[0], 60, "preview_size downscales the longest edge");

  const inspected = await call("paint_inspect", { canvas: "integration", points: [[25, 30], [90, 30]] });
  assert.match(inspected.text, /pixel \(25,30\) = #e0533dff/);
  assert.match(inspected.text, /pixel \(90,30\) = #ffd166ff/);

  const undone = await call("paint_undo", { canvas: "integration", steps: 5 });
  assert.match(undone.text, /undo 5 step/, "the batch, the extra layer and every op roll back one step at a time");
  const afterUndo = await call("paint_inspect", { canvas: "integration", points: [[25, 30]] });
  assert.match(afterUndo.text, /#101820ff/, "undo reveals the original background colour");
  const redone = await call("paint_undo", { canvas: "integration", action: "redo", steps: 5 });
  assert.match(redone.text, /redo 5 step/);
  const afterRedo = await call("paint_inspect", { canvas: "integration", points: [[25, 30]] });
  assert.match(afterRedo.text, /#e0533dff/, "redo brings the drawing back");

  const exported = await call("paint_export", { canvas: "integration", format: "png", path: "out/art.png" });
  assert.match(exported.text, /exported/);
  assert.ok(existsSync(path.join(root, "out", "art.png")), "export file missing");

  const svg = await call("paint_export", { canvas: "integration", format: "svg", path: "out/art.svg" });
  assert.match(svg.text, /svg written/);
  assert.ok(existsSync(path.join(root, "out", "art.svg")));
});

test("bad input produces an actionable error, not a crash", async () => {
  const missing = await call("paint_rect", { canvas: "nope", x: 0, y: 0, width: 4, height: 4, fill: "#f00" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.text, /No canvas named "nope"/);
  assert.match(missing.text, /paint_canvas action:'create'/);

  const badParams = await call("paint_rect", { canvas: "integration", x: 0 });
  assert.equal(badParams.result.isError, true);
  assert.match(badParams.text, /paint_rect/);
  assert.match(badParams.text, /width/);

  const badOp = await call("paint_ops", { canvas: "integration", ops: [{ op: "rect", x: 0 }] });
  assert.match(badOp.text, /Invalid parameters for "rect"/, "batch ops report the registry validator");
  const unknownOp = await call("paint_ops", { canvas: "integration", ops: [{ op: "sparkle" }] });
  assert.match(unknownOp.text, /Unknown op "sparkle"/, "a bad batch item is reported, not thrown at the protocol");
  assert.match(String(unknownOp.structured.failed), /Unknown op/);

  const escape = await call("paint_export", { canvas: "integration", path: "../../outside.png", format: "png" });
  assert.equal(escape.result.isError, true);
  assert.match(escape.text, /outside the paint root/);
});

test("help topics and layer tools answer without drawing", async () => {
  const help = await call("paint_help", { topic: "ops" });
  assert.match(help.text, /paint_brush/);
  const colors = await call("paint_help", { topic: "colors" });
  assert.match(colors.text, /named colours/);
  const layers = await call("paint_layer", { canvas: "integration", action: "add", name: "detail" });
  assert.match(layers.text, /added layer/);
  const listed = await call("paint_layer", { canvas: "integration", action: "list" });
  assert.match(listed.text, /detail/);
});
