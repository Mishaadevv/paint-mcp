import type { PathShape, Subpath } from "../types.js";

const TAU = Math.PI * 2;

export function openPath(...subpaths: Subpath[]): PathShape {
  return { subpaths, closed: false };
}

export function closedPath(...subpaths: Subpath[]): PathShape {
  return { subpaths, closed: true };
}

export function rectSubpath(x: number, y: number, width: number, height: number): Subpath {
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
}

/** Rounded rectangle outline; `radius` may be `[tl, tr, br, bl]`. */
export function roundedRectSubpath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number | readonly number[],
  segments = 8,
): Subpath {
  const uniform = typeof radius === "number" ? [radius, radius, radius, radius] : [...radius];
  const maxR = Math.min(width, height) / 2;
  const clamp = (value: number): number => Math.max(0, Math.min(maxR, value));
  const tl = clamp(uniform[0] ?? 0);
  const tr = clamp(uniform[1] ?? tl);
  const br = clamp(uniform[2] ?? tl);
  const bl = clamp(uniform[3] ?? tr);
  const out: Subpath = [];
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number): void => {
    if (r <= 0.01) {
      out.push([cx, cy]);
      return;
    }
    for (let i = 0; i <= segments; i++) {
      const a = a0 + ((a1 - a0) * i) / segments;
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  arc(x + tl, y + tl, tl, Math.PI, Math.PI * 1.5);
  arc(x + width - tr, y + tr, tr, Math.PI * 1.5, TAU);
  arc(x + width - br, y + height - br, br, 0, Math.PI * 0.5);
  arc(x + bl, y + height - bl, bl, Math.PI * 0.5, Math.PI);
  return out;
}

export function ellipseSubpath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startDeg = 0,
  endDeg = 360,
  rotationDeg = 0,
): Subpath {
  const span = Math.abs(endDeg - startDeg);
  const segments = Math.max(8, Math.min(512, Math.ceil(span / 6) + 2));
  const rot = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const out: Subpath = [];
  for (let i = 0; i <= segments; i++) {
    const a = ((startDeg + (span * i) / segments) * Math.PI) / 180;
    const px = Math.cos(a) * rx;
    const py = Math.sin(a) * ry;
    out.push([cx + px * cos - py * sin, cy + px * sin + py * cos]);
  }
  return out;
}

export function lineSubpath(x0: number, y0: number, x1: number, y1: number): Subpath {
  return [
    [x0, y0],
    [x1, y1],
  ];
}

/** Flatten a cubic bezier into a polyline using a chord-flatness test. */
export function cubicSubpath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tolerance = 0.2,
): Subpath {
  const out: Subpath = [[x0, y0]];
  const walk = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    depth: number,
  ): void => {
    const chordX = dx - ax;
    const chordY = dy - ay;
    const len = Math.hypot(chordX, chordY);
    if (depth >= 14 || len < 1e-6) {
      out.push([dx, dy]);
      return;
    }
    const nx = chordY / len;
    const ny = -chordX / len;
    const off = (px: number, py: number): number => Math.abs((px - ax) * nx + (py - ay) * ny);
    if (off(bx, by) + off(cx, cy) <= tolerance) {
      out.push([dx, dy]);
      return;
    }
    const abx = (ax + bx) / 2;
    const aby = (ay + by) / 2;
    const bcx = (bx + cx) / 2;
    const bcy = (by + cy) / 2;
    const cdx = (cx + dx) / 2;
    const cdy = (cy + dy) / 2;
    const m1x = (abx + bcx) / 2;
    const m1y = (aby + bcy) / 2;
    const m2x = (bcx + cdx) / 2;
    const m2y = (bcy + cdy) / 2;
    const mx = (m1x + m2x) / 2;
    const my = (m1y + m2y) / 2;
    walk(ax, ay, abx, aby, m1x, m1y, mx, my, depth + 1);
    walk(mx, my, m2x, m2y, cdx, cdy, dx, dy, depth + 1);
  };
  walk(x0, y0, x1, y1, x2, y2, x3, y3, 0);
  return out;
}

export function quadraticSubpath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  tolerance = 0.25,
): Subpath {
  // exact degree elevation to cubic
  return cubicSubpath(
    x0,
    y0,
    x0 + (2 / 3) * (x1 - x0),
    y0 + (2 / 3) * (y1 - y0),
    x2 + (2 / 3) * (x1 - x2),
    y2 + (2 / 3) * (y1 - y2),
    x2,
    y2,
    tolerance,
  );
}

/** Elliptical arc (SVG style) flattened to a polyline. */
export function svgArcSubpath(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x1: number,
  y1: number,
): Subpath {
  if (x0 === x1 && y0 === y1) return [[x0, y0]];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return lineSubpath(x0, y0, x1, y1);
  const phi = ((rotationDeg % 360) * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x1) / 2;
  const dy = (y0 - y1) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = factor * ((rx * y1p) / ry);
  const cyp = factor * ((-ry * x1p) / rx);
  const cx = cxp * cos - cyp * sin + (x0 + x1) / 2;
  const cy = cxp * sin + cyp * cos + (y0 + y1) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  const theta2 = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  let delta = theta2 - theta1;
  if (!sweep && delta > 0) delta -= TAU;
  if (sweep && delta < 0) delta += TAU;
  const segments = Math.max(6, Math.min(256, Math.ceil(Math.abs(delta) / 0.06)));
  const out: Subpath = [];
  for (let i = 0; i <= segments; i++) {
    const a = theta1 + (delta * i) / segments;
    const px = rx * Math.cos(a);
    const py = ry * Math.sin(a);
    out.push([px * cos - py * sin + cx, px * sin + py * cos + cy]);
  }
  out[0] = [x0, y0];
  out[out.length - 1] = [x1, y1];
  return out;
}

/**
 * Parse SVG path data (`M`, `L`, `H`, `V`, `C`, `S`, `Q`, `T`, `A`, `Z`, lower-case = relative).
 * Lets an agent describe vector art with the syntax it already knows.
 */
export function parseSvgPath(d: string): PathShape {
  const tokens = d.match(/[aAcCfFhHlLmMqQsStTvVzZ]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens || tokens.length === 0) throw new Error("Empty path data");
  const subpaths: Subpath[] = [];
  let currentIndex = -1;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let c1x = 0;
  let c1y = 0;
  let q1x = 0;
  let q1y = 0;
  let lastCommand = "";
  let index = 0;
  let closed = true;

  const num = (): number => {
    const raw = tokens[index++];
    const value = Number.parseFloat(raw ?? "");
    if (!Number.isFinite(value)) throw new Error(`Bad number in path data near "${raw}"`);
    return value;
  };
  const move = (nx: number, ny: number): void => {
    subpaths.push([[nx, ny]]);
    currentIndex = subpaths.length - 1;
    x = nx;
    y = ny;
  };
  const add = (sub: Subpath): void => {
    if (currentIndex < 0 || !subpaths[currentIndex] || subpaths[currentIndex].length === 0) move(x, y);
    const target = subpaths[currentIndex];
    for (const point of sub) target.push(point);
    x = sub[sub.length - 1][0];
    y = sub[sub.length - 1][1];
  };

  while (index < tokens.length) {
    let command = tokens[index];
    let isImplicit = false;
    if (/[a-zA-Z]/.test(command)) {
      lastCommand = command;
      index++;
    } else {
      // implicit repetition of the previous command
      command = lastCommand;
      isImplicit = true;
      if (command === "m" || command === "M") {
        command = command === "m" ? "l" : "L";
      }
    }
    if (index >= tokens.length) break;
    const relative = command === command.toLowerCase();
    const dx = relative ? x : 0;
    const dy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case "M": {
        const nx = num() + dx;
        const ny = num() + dy;
        startX = nx;
        startY = ny;
        move(nx, ny);
        if (isImplicit) closed = false;
        break;
      }
      case "L":
        add(lineSubpath(x, y, num() + dx, num() + dy));
        break;
      case "H": {
        const nx = num() + dx;
        add(lineSubpath(x, y, nx, y));
        x = nx;
        break;
      }
      case "V": {
        const ny = num() + dy;
        add(lineSubpath(x, y, x, ny));
        y = ny;
        break;
      }
      case "C": {
        const x1 = num() + dx;
        const y1 = num() + dy;
        const x2 = num() + dx;
        const y2 = num() + dy;
        const x3 = num() + dx;
        const y3 = num() + dy;
        add(cubicSubpath(x, y, x1, y1, x2, y2, x3, y3));
        c1x = x2;
        c1y = y2;
        break;
      }
      case "S": {
        const reflection = lastCommand.toUpperCase() === "C" || lastCommand.toUpperCase() === "S";
        const x1 = reflection ? 2 * x - c1x : x;
        const y1 = reflection ? 2 * y - c1y : y;
        const x2 = num() + dx;
        const y2 = num() + dy;
        const x3 = num() + dx;
        const y3 = num() + dy;
        add(cubicSubpath(x, y, x1, y1, x2, y2, x3, y3));
        c1x = x2;
        c1y = y2;
        break;
      }
      case "Q": {
        const x1 = num() + dx;
        const y1 = num() + dy;
        const x2 = num() + dx;
        const y2 = num() + dy;
        add(quadraticSubpath(x, y, x1, y1, x2, y2));
        q1x = x1;
        q1y = y1;
        break;
      }
      case "T": {
        const reflection = lastCommand.toUpperCase() === "Q" || lastCommand.toUpperCase() === "T";
        const x1 = reflection ? 2 * x - q1x : x;
        const y1 = reflection ? 2 * y - q1y : y;
        const x2 = num() + dx;
        const y2 = num() + dy;
        add(quadraticSubpath(x, y, x1, y1, x2, y2));
        q1x = x1;
        q1y = y1;
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() === 1;
        const sweep = num() === 1;
        const nx = num() + dx;
        const ny = num() + dy;
        add(svgArcSubpath(x, y, rx, ry, rot, large, sweep, nx, ny));
        break;
      }
      case "Z": {
        const last = currentIndex >= 0 ? subpaths[currentIndex] : null;
        if (last && last.length > 1) last.push([last[0][0], last[0][1]]);
        x = startX;
        y = startY;
        currentIndex = -1;
        break;
      }
      default:
        throw new Error(`Unsupported path command "${command}" in "${d.slice(0, 40)}…"`);
    }
    lastCommand = command;
  }
  const usable = subpaths.filter((s) => s.length >= 2);
  if (usable.length === 0) throw new Error("Path data produced no drawable segments");
  return { subpaths: usable, closed };
}
