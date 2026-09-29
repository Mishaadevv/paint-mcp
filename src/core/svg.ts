import type { Raster } from "../types.js";
import { toHex } from "./color.js";
import type { PaintDocument } from "./document.js";
import { encodePng } from "./png.js";
import { OPS } from "./ops.js";
import { styleOf, type PaintSpec } from "./schemas.js";

export interface SvgExportResult {
  svg: string;
  exported: string[];
  skipped: string[];
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function paintRef(value: unknown, box: Box, defs: string[], idPrefix: string): string {
  if (value === undefined || value === null) return "none";
  const style = styleOf(value as PaintSpec, box);
  if (style.kind === "solid") return toHex(style.color);
  if (style.kind === "pattern") return "#808080";
  const id = `${idPrefix}${defs.length}`;
  const stops = style.stops
    .map((stop) => `      <stop offset="${fmt(stop.at)}" stop-color="${toHex(stop.color, false)}" stop-opacity="${fmt(stop.color.a / 255)}"/>`)
    .join("\n");
  defs.push(
    style.kind === "linear"
      ? `    <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(style.x0)}" y1="${fmt(style.y0)}" x2="${fmt(style.x1)}" y2="${fmt(style.y1)}">\n${stops}\n    </linearGradient>`
      : `    <radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(style.cx)}" cy="${fmt(style.cy)}" r="${fmt(style.r)}">\n${stops}\n    </radialGradient>`,
  );
  return `url(#${id})`;
}

function pointsAttribute(points: unknown): string {
  const list = Array.isArray(points) ? points : [];
  return list.map((p: unknown[]) => `${fmt(num(p[0]))},${fmt(num(p[1]))}`).join(" ");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function isVectorizable(op: string): boolean {
  return OPS[op]?.vector === true;
}

/**
 * Rebuild the recorded vector operations as SVG. Raster-only steps (brush, bucket
 * fill, filters, pixel writes) have no vector form and are reported back.
 */
export function documentToSvg(
  doc: PaintDocument,
  options: { background?: string; embedRasterFallback?: boolean } = {},
): SvgExportResult {
  const defs: string[] = [];
  const exported: string[] = [];
  const skipped: string[] = [];
  const body: string[] = [];

  for (const entry of doc.opLog) {
    const p = entry.params;
    const opacity = num(p.opacity, 1);
    const strength = opacity < 1 ? ` opacity="${fmt(opacity)}"` : "";
    const box: Box = { x: num(p.x ?? p.cx ?? p.x1), y: num(p.y ?? p.cy ?? p.y1), width: num(p.width, doc.width), height: num(p.height, doc.height) };
    switch (entry.op) {
      case "rect": {
        const fill = paintRef(p.fill, box, defs, "g");
        const stroke = paintRef(p.stroke, box, defs, "s");
        const rx = typeof p.radius === "number" ? ` rx="${fmt(p.radius)}"` : "";
        body.push(
          `    <rect x="${fmt(num(p.x))}" y="${fmt(num(p.y))}" width="${fmt(num(p.width))}" height="${fmt(num(p.height))}"${rx} fill="${fill}" stroke="${p.stroke ? stroke : "none"}" stroke-width="${fmt(num(p.stroke_width, 2))}"${strength}/>`,
        );
        exported.push("rect");
        break;
      }
      case "ellipse": {
        const rx = num(p.radius ?? p.rx);
        const ry = num(p.radius ?? p.ry);
        const fill = paintRef(p.fill, box, defs, "g");
        const stroke = paintRef(p.stroke, box, defs, "s");
        const rotate = num(p.rotation) ? ` transform="rotate(${fmt(num(p.rotation))} ${fmt(num(p.cx))} ${fmt(num(p.cy))})"` : "";
        body.push(
          `    <ellipse cx="${fmt(num(p.cx))}" cy="${fmt(num(p.cy))}" rx="${fmt(rx)}" ry="${fmt(ry)}"${rotate} fill="${fill}" stroke="${p.stroke ? stroke : "none"}" stroke-width="${fmt(num(p.stroke_width, 2))}"${strength}/>`,
        );
        exported.push("ellipse");
        break;
      }
      case "line": {
        const stroke = paintRef(p.color, box, defs, "l");
        const dash = Array.isArray(p.dashes) ? ` stroke-dasharray="${(p.dashes as number[]).map(fmt).join(",")}"` : "";
        body.push(
          `    <line x1="${fmt(num(p.x1))}" y1="${fmt(num(p.y1))}" x2="${fmt(num(p.x2))}" y2="${fmt(num(p.y2))}" stroke="${stroke}" stroke-width="${fmt(num(p.width, 2))}" stroke-linecap="${p.cap ?? "round"}"${dash}${strength}/>`,
        );
        exported.push("line");
        break;
      }
      case "polygon": {
        const fill = paintRef(p.fill, box, defs, "g");
        const stroke = paintRef(p.stroke, box, defs, "s");
        body.push(
          `    <polygon points="${pointsAttribute(p.points)}" fill="${fill}" fill-rule="${p.even_odd ? "evenodd" : "nonzero"}" stroke="${p.stroke ? stroke : "none"}" stroke-width="${fmt(num(p.stroke_width, 2))}"${strength}/>`,
        );
        exported.push("polygon");
        break;
      }
      case "path": {
        const fill = paintRef(p.fill, box, defs, "g");
        const stroke = paintRef(p.stroke, box, defs, "s");
        const translate = Array.isArray(p.translate) ? (p.translate as number[]) : undefined;
        const transform =
          translate || p.scale
            ? ` transform="translate(${fmt(num(translate?.[0], 0))} ${fmt(num(translate?.[1], 0))}) scale(${fmt(num(p.scale, 1))})"`
            : "";
        body.push(
          `    <path d="${escapeAttribute(String(p.d ?? ""))}" fill="${p.fill ? fill : "none"}" fill-rule="${p.even_odd ? "evenodd" : "nonzero"}" stroke="${p.stroke ? stroke : "none"}" stroke-width="${fmt(num(p.stroke_width, 2))}" stroke-linecap="${p.cap ?? "round"}"${transform}${strength}/>`,
        );
        exported.push("path");
        break;
      }
      case "text": {
        const anchor = p.align === "center" ? "middle" : p.align === "right" ? "end" : "start";
        const fill = paintRef(p.color ?? "#000000", box, defs, "t");
        const lines = String(p.text ?? "").split("\n");
        const size = fmt(num(p.scale, 3) * 7);
        const tspans = lines
          .map((line, index) => `      <tspan x="${fmt(num(p.x))}" dy="${index === 0 ? 0 : num(p.line_spacing, 2) + 7}">${escapeText(line)}</tspan>`)
          .join("");
        body.push(
          `    <text x="${fmt(num(p.x))}" y="${fmt(num(p.y))}" font-family="monospace" font-size="${size}" text-anchor="${anchor}" fill="${fill}" xml:space="preserve">${tspans}</text>`,
        );
        exported.push("text");
        break;
      }
      case "gradient": {
        const area = (p.area as Box | undefined) ?? { x: 0, y: 0, width: doc.width, height: doc.height };
        const fill = paintRef({ type: p.type, from: p.from, to: p.to, radius: p.radius, colors: p.colors, stops: p.stops }, area, defs, "w");
        body.push(
          p.shape === "ellipse"
            ? `    <ellipse cx="${fmt(area.x + area.width / 2)}" cy="${fmt(area.y + area.height / 2)}" rx="${fmt(area.width / 2)}" ry="${fmt(area.height / 2)}" fill="${fill}"${strength}/>`
            : `    <rect x="${fmt(area.x)}" y="${fmt(area.y)}" width="${fmt(area.width)}" height="${fmt(area.height)}" fill="${fill}"${strength}/>`,
        );
        exported.push("gradient");
        break;
      }
      default:
        skipped.push(entry.op);
    }
  }

  const uniqueSkipped = [...new Set(skipped)];
  const background = options.background
    ? `  <rect width="100%" height="100%" fill="${escapeAttribute(options.background)}"/>\n`
    : "";
  const raster = options.embedRasterFallback ? `  <image href="${rasterDataUri(doc.composite())}" width="${doc.width}" height="${doc.height}"/>\n` : "";
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">
  <!-- Generated by paint-mcp from ${doc.opLog.length} recorded operation(s). -->${
    uniqueSkipped.length > 0 ? `\n  <!-- Raster-only steps have no vector form and are omitted: ${uniqueSkipped.join(", ")}. -->` : ""
  }
${raster}${background}${defs.length > 0 ? `  <defs>\n${defs.join("\n")}\n  </defs>\n` : ""}${body.join("\n")}
</svg>
`;
  return { svg: header, exported, skipped: uniqueSkipped };
}

/** Base64 PNG data URI for a raster. */
export function rasterDataUri(img: Raster): string {
  return `data:image/png;base64,${encodePng(img).toString("base64")}`;
}
