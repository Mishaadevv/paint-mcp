#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./core/store.js";
import { OP_NAMES } from "./core/execute.js";
import { HELP_TEXT, parseConfig } from "./util/config.js";
import { PreviewServer } from "./util/serve.js";
import { registerTools } from "./util/register.js";

const VERSION: string = (() => {
  try {
    const json = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return json.version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
})();

const INSTRUCTIONS = `paint-mcp gives you a real paint canvas you can look at.

Start: paint_canvas {action:"create", canvas:"<name>", width, height, background:"#hex"|null}.
Draw: one tool per operation (paint_rect, paint_ellipse, paint_line, paint_path, paint_brush, paint_text, paint_pixel_grid, paint_pixels, paint_fill, paint_gradient, paint_polygon, paint_stamp, paint_clear, paint_filter, paint_transform, paint_layer) — or plan a whole scene in one call with paint_ops, which is far cheaper in tokens.
Check: every drawing reply contains the picture. Read it, judge it, then fix specific shapes; paint_preview and paint_inspect re-read without drawing.
Undo: paint_undo. Export: paint_export (png/jpg/bmp/svg/.paint). Import: paint_import. Reference: paint_help topics: ops, colors, blend, filters, svg, limits, workflow, examples.
Colours accept "#hex", "rgb()", "hsl()", ${"named colours"}, or {r,g,b,a}. Gradients: {type:"linear"|"radial", from, to, colors|stops}.
Text uses a built-in 5x7 pixel font (ASCII, transliterated input); for organic lettering use paint_path or paint_brush.`;

const argv = process.argv.slice(2);
const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}

if (argv.includes("--version")) {
  process.stdout.write(`paint-mcp ${VERSION}\n`);
  process.exit(0);
}

const config = parseConfig(argv);
const store = new Store({
  root: config.root,
  historyLimit: config.historyLimit,
  maxPixels: config.maxPixels,
  autoSave: config.autoSave,
  allowAbsolute: config.allowAbsolutePaths,
});
const preview = new PreviewServer(store);
if (config.servePort > 0) {
  log(`live preview: ${preview.start(config.servePort)}`);
}

const server = new McpServer({ name: "paint-mcp-server", version: VERSION }, { instructions: INSTRUCTIONS });
const tools = registerTools(server, { store, config, preview });

const transport = new StdioServerTransport();
await server.connect(transport);

log(
  `paint-mcp ${VERSION} ready · root ${config.root} · preview ${config.preview} (${config.previewSize}px) · ` +
    `${tools.length} tools (${OP_NAMES.length} drawing ops)${config.toolset === "compact" ? " [compact toolset]" : ""}`,
);
