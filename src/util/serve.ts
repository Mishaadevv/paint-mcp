import { createServer, type Server } from "node:http";
import type { Store } from "../core/store.js";
import { encodePng } from "../core/png.js";

/**
 * Tiny localhost viewer that shows every open canvas and repaints itself, so a
 * human can watch an agent draw without re-opening files.
 */
export class PreviewServer {
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly store: Store) {}

  get url(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/` : null;
  }

  get running(): boolean {
    return this.server !== null;
  }

  start(port: number): string {
    if (this.server) return this.url ?? "";
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/image") {
        const name = url.searchParams.get("canvas") ?? "";
        try {
          const doc = this.store.get(name);
          const body = encodePng(doc.composite(), { level: 3 });
          response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "content-length": body.length });
          response.end(body);
        } catch (error) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end(String(error instanceof Error ? error.message : error));
        }
        return;
      }
      if (url.pathname !== "/") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      const canvases = this.store.list();
      const cards = canvases
        .map(
          (doc) => `    <figure>
      <figcaption><b>${escapeHtml(doc.name)}</b> · ${doc.width}×${doc.height} · ${doc.layers.length} layer(s) · rev ${doc.revision}</figcaption>
      <img src="/image?canvas=${encodeURIComponent(doc.name)}" alt="${escapeHtml(doc.name)}" />
    </figure>`,
        )
        .join("\n");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="1" />
<title>paint-mcp live preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 24px; font: 14px/1.4 system-ui, sans-serif; background: #15171c; color: #e8eaed; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { color: #9aa0a6; margin: 0 0 20px; }
  main { display: flex; flex-wrap: wrap; gap: 20px; }
  figure { margin: 0; background: #1f2229; border: 1px solid #2c3038; border-radius: 10px; padding: 12px; }
  figcaption { margin-bottom: 8px; }
  img { image-rendering: pixelated; max-width: 560px; height: auto; background:
      conic-gradient(from 0deg, #2a2d34 0 25%, #23262c 0 50%, #2a2d34 0 75%, #23262c 0) 0 0/16px 16px; border-radius: 6px; }
</style>
</head>
<body>
  <h1>paint-mcp live preview</h1>
  <p>${canvases.length} open canvas(es) · auto-refreshes every second · page reloads itself</p>
  <main>
${cards || "    <p>No canvases yet — create one with paint_canvas.</p>"}
  </main>
</body>
</html>
`);
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      this.port = typeof address === "object" && address ? address.port : port;
    });
    this.server = server;
    return `http://127.0.0.1:${port}/`;
  }

  stop(): boolean {
    if (!this.server) return false;
    this.server.close();
    this.server = null;
    this.port = 0;
    return true;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
