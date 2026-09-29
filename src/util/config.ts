import path from "node:path";

export type PreviewSetting = "auto" | "none" | "thumb" | "full";

export interface ServerConfig {
  /** Folder every canvas and export lives in. */
  root: string;
  /** Default image reply for tool results. */
  preview: PreviewSetting;
  /** Longest edge of a thumbnail in pixels. */
  previewSize: number;
  historyLimit: number;
  maxPixels: number;
  /** Write a .paint file after every draw call. */
  autoSave: boolean;
  /** Live preview HTTP port, 0 disables it. */
  servePort: number;
  /** Allow file reads outside `root`. */
  allowAbsolutePaths: boolean;
  /** `full` registers one tool per drawing operation; `compact` only the batch tool. */
  toolset: "full" | "compact";
}

const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
};

export function parseConfig(argv: string[]): ServerConfig {
  const flag = (name: string): string | undefined => {
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const previews: readonly PreviewSetting[] = ["auto", "none", "thumb", "full"];
  const requestedPreview = (flag("preview") ?? process.env.PAINT_MCP_PREVIEW ?? "auto").trim().toLowerCase();
  const root = flag("root") ?? process.env.PAINT_MCP_ROOT ?? path.resolve(process.cwd(), "canvases");
  return {
    root: path.resolve(root),
    preview: (previews as readonly string[]).includes(requestedPreview) ? (requestedPreview as PreviewSetting) : "auto",
    previewSize: envNumber("PAINT_MCP_PREVIEW_SIZE", Number.parseInt(flag("preview-size") ?? "", 10) || 640),
    historyLimit: envNumber("PAINT_MCP_HISTORY", Number.parseInt(flag("history") ?? "", 10) || 24),
    maxPixels: envNumber("PAINT_MCP_MAX_PIXELS", 40_000_000),
    autoSave: has("auto-save") || process.env.PAINT_MCP_AUTOSAVE === "1",
    servePort: Number.parseInt(flag("serve") ?? process.env.PAINT_MCP_SERVE ?? "", 10) || 0,
    allowAbsolutePaths: has("allow-absolute") || process.env.PAINT_MCP_ALLOW_ABSOLUTE === "1",
    toolset: (flag("toolset") ?? process.env.PAINT_MCP_TOOLSET ?? "full").trim().toLowerCase() === "compact" ? "compact" : "full",
  };
}

export const HELP_TEXT = `paint-mcp — an MCP server that gives an agent a real paint canvas.

Usage:
  paint-mcp [flags]

Flags:
  --root <dir>          folder for canvases and exports (default ./canvases, env PAINT_MCP_ROOT)
  --preview <mode>      auto|none|thumb|full — image reply in every tool result (default auto)
  --preview-size <px>   longest edge of a preview thumbnail (default 640)
  --history <n>         undo steps kept per canvas (default 24)
  --serve <port>        serve a live auto-refreshing preview page on http://127.0.0.1:<port>
  --auto-save           write the .paint document after every drawing call
  --allow-absolute      let import/export touch absolute paths outside --root
  --help, --version

Environment: PAINT_MCP_ROOT, PAINT_MCP_PREVIEW, PAINT_MCP_PREVIEW_SIZE, PAINT_MCP_HISTORY,
PAINT_MCP_MAX_PIXELS, PAINT_MCP_AUTOSAVE, PAINT_MCP_SERVE, PAINT_MCP_ALLOW_ABSOLUTE
`;
