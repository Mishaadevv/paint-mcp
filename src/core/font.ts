import type { Raster, Rgba } from "../types.js";
import { setPixel } from "./image.js";

/**
 * 5x7 pixel font, one glyph per row, 7 rows separated by `/`.
 * Kept as bitmaps so the server has zero font files and zero native deps.
 */
const GLYPHS: Record<string, string> = {
  " ": "...../...../...../...../...../...../.....",
  "!": "..#../..#../..#../..#../..#../...../..#..",
  '"': ".#.#./.#.#./...../...../...../...../.....",
  "#": ".#.#./#####/.#.#./#####/.#.#./...../.....",
  $: "..#../.####/#.#../.###./..#.#/####./..#..",
  "%": "##.../##..#/...#./..#../.#.../#..##/...##",
  "&": ".##../#..#./#..#./.##../#.#.#/#..#./.##.#",
  "'": "..#../..#../...../...../...../...../.....",
  "(": "...#./..#../.#.../.#.../.#.../..#../...#.",
  ")": ".#.../..#../...#./...#./...#./..#../.#...",
  "*": "...../#.#.#/.###./#####/.###./#.#.#/.....",
  "+": "...../..#../..#../#####/..#../..#../.....",
  ",": "...../...../...../...../..#../..#../.#...",
  "-": "...../...../...../#####/...../...../.....",
  ".": "...../...../...../...../..#../..#../.....",
  "/": "....#/....#/...#./..#../.#.../#..../#....",
  "0": ".###./#...#/#..##/#.#.#/##..#/#...#/.###.",
  "1": "..#../.##../..#../..#../..#../..#../.###.",
  "2": ".###./#...#/....#/...#./..#../.#.../#####",
  "3": ".###./#...#/....#/.##../....#/#...#/.###.",
  "4": "...#./..##./.#.#./#..#./#####/...#./...#.",
  "5": "#####/#..../####./....#/....#/#...#/.###.",
  "6": "..#../.#.../#..../####./#...#/#...#/.###.",
  "7": "#####/....#/...#./..#../.#.../.#.../.#...",
  "8": ".###./#...#/#...#/.###./#...#/#...#/.###.",
  "9": ".###./#...#/#...#/.####/....#/...#./.##..",
  ":": "...../..#../...../...../..#../...../.....",
  ";": "...../..#../...../...../..#../..#../.#...",
  "<": "...#./..#../.#.../#..../.#.../..#../...#.",
  "=": "...../...../#####/...../#####/...../.....",
  ">": ".#.../..#../...#./....#/...#./..#../.#...",
  "?": ".###./#...#/....#/..##./..#../...../..#..",
  "@": ".###./#...#/#.###/#.#.#/#.###/#..../.###.",
  A: ".###./#...#/#...#/#####/#...#/#...#/#...#",
  B: "####./#...#/#...#/####./#...#/#...#/####.",
  C: ".###./#...#/#..../#..../#..../#...#/.###.",
  D: "###../#..#./#...#/#...#/#...#/#..#./###..",
  E: "#####/#..../#..../####./#..../#..../#####",
  F: "#####/#..../#..../####./#..../#..../#....",
  G: ".###./#...#/#..../#.###/#...#/#...#/.###.",
  H: "#...#/#...#/#...#/#####/#...#/#...#/#...#",
  I: ".###./..#../..#../..#../..#../..#../.###.",
  J: ".####/...#./...#./...#./#..#./#..#./.##..",
  K: "#...#/#..#./#.#../##.../#.#../#..#./#...#",
  L: "#..../#..../#..../#..../#..../#..../#####",
  M: "#...#/##.##/#.#.#/#...#/#...#/#...#/#...#",
  N: "#...#/##..#/#.#.#/#..##/#...#/#...#/#...#",
  O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
  P: "####./#...#/#...#/####./#..../#..../#....",
  Q: ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#",
  R: "####./#...#/#...#/####./#.#../#..#./#...#",
  S: ".###./#...#/#..../.###./....#/#...#/.###.",
  T: "#####/..#../..#../..#../..#../..#../..#..",
  U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.",
  V: "#...#/#...#/#...#/#...#/#...#/.#.#./..#..",
  W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#",
  X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#",
  Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
  Z: "#####/....#/...#./..#../.#.../#..../#####",
  "[": ".###./.#.../.#.../.#.../.#.../.#.../.###.",
  "\\": "#..../#..../.#.../..#../...#./....#/....#",
  "]": ".###./...#./...#./...#./...#./...#./.###.",
  "^": "..#../.#.#./#...#/...../...../...../.....",
  _: "...../...../...../...../...../...../#####",
  "`": ".#.../..#../...../...../...../...../.....",
  a: "...../...../.###./....#/.####/#...#/.####",
  b: "#..../#..../####./#...#/#...#/#...#/####.",
  c: "...../...../.###./#...#/#..../#...#/.###.",
  d: "....#/....#/.####/#...#/#...#/#...#/.####",
  e: "...../...../.###./#...#/#####/#..../.###.",
  f: "..##./.#.../.#.../####./.#.../.#.../.#...",
  g: "...../.####/#...#/#...#/.####/....#/.###.",
  h: "#..../#..../####./#...#/#...#/#...#/#...#",
  i: "..#../...../.##../..#../..#../..#../.###.",
  j: "...#./...../...#./...#./...#./#..#./.##..",
  k: "#..../#..../#..#./#.#../##.../#.#../#..#.",
  l: ".##../..#../..#../..#../..#../..#../.###.",
  m: "...../...../##.#./#.#.#/#.#.#/#...#/#...#",
  n: "...../...../####./#...#/#...#/#...#/#...#",
  o: "...../...../.###./#...#/#...#/#...#/.###.",
  p: "...../...../####./#...#/#...#/#...#/#....",
  q: "...../...../.####/#...#/#...#/.####/....#",
  r: "...../...../#.##./##.../#..../#..../#....",
  s: "...../...../.####/#..../.###./....#/####.",
  t: ".#.../.#.../####./.#.../.#.../.#..#/..##.",
  u: "...../...../#...#/#...#/#...#/#...#/.###.",
  v: "...../...../#...#/#...#/#...#/.#.#./..#..",
  w: "...../...../#...#/#...#/#.#.#/#.#.#/.#.#.",
  x: "...../...../#...#/.#.#./..#../.#.#./#...#",
  y: "...../...../#...#/#...#/#...#/.####/....#",
  z: "...../...../#####/...#./..#../.#.../#####",
  "{": "...#./...#./..#../.#.../..#../...#./...#.",
  "|": "..#../..#../..#../..#../..#../..#../..#..",
  "}": ".#.../.#.../..#../...#./..#../.#.../.#...",
  "~": "...../...../.#..#/#.#.#/#..#./...../.....",
};

export const FONT_WIDTH = 5;
export const FONT_HEIGHT = 7;
export const FONT_GAP = 1;

const decoded = new Map<string, number[]>();
for (const [char, bitmap] of Object.entries(GLYPHS)) {
  const rows = bitmap.split("/");
  decoded.set(
    char,
    rows.map((row) => {
      let bits = 0;
      for (let i = 0; i < FONT_WIDTH; i++) if (row[i] === "#") bits |= 1 << (FONT_WIDTH - 1 - i);
      return bits;
    }),
  );
}

export function hasGlyph(char: string): boolean {
  return decoded.has(char);
}

export const supportedCharacters = Object.keys(GLYPHS).join("");

/** Latin look-alikes so Russian prompts still label something readable. */
const TRANSLITERATION: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya", і: "i", ї: "i", є: "e", ґ: "g",
};

export function transliterate(text: string): string {
  let out = "";
  for (const char of text) {
    if (hasGlyph(char) || hasGlyph(char.toLowerCase())) {
      out += char;
      continue;
    }
    const lower = char.toLowerCase();
    if (TRANSLITERATION[lower] !== undefined) {
      const mapped = TRANSLITERATION[lower];
      out += char === lower ? mapped : mapped.toUpperCase();
      continue;
    }
    out += " ";
  }
  return out;
}

export function measureText(text: string, scale = 1, letterSpacing = 1): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  return {
    width: Math.max(0, longest * (FONT_WIDTH + letterSpacing) * scale),
    height: lines.length * (FONT_HEIGHT + 2) * scale - 2 * scale,
  };
}

export interface TextRenderOptions {
  scale?: number;
  letterSpacing?: number;
  lineSpacing?: number;
  color?: Rgba;
  /** Draw an outline ring of `outline` pixels in `outlineColor`. */
  outline?: number;
  outlineColor?: Rgba;
}

/** Render a text block into its own transparent raster (composites anywhere). */
export function renderText(text: string, options: TextRenderOptions = {}): Raster {
  const scale = Math.max(1, Math.round(options.scale ?? 1));
  const tracking = Math.max(0, Math.round(options.letterSpacing ?? 1));
  const leading = Math.max(0, Math.round(options.lineSpacing ?? 2));
  const color = options.color ?? { r: 0, g: 0, b: 0, a: 255 };
  const outline = Math.max(0, Math.round(options.outline ?? 0));
  const lines = text.split("\n");
  const cellW = (FONT_WIDTH + tracking) * scale;
  const cellH = (FONT_HEIGHT + leading) * scale;
  const pad = outline * scale;
  const width = Math.max(1, Math.max(...lines.map((l) => l.length), 1) * cellW + pad * 2);
  const height = Math.max(1, lines.length * cellH - leading * scale + pad * 2);
  const raster = { width, height, data: new Uint8ClampedArray(width * height * 4) };

  const put = (x: number, y: number, c: Rgba): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    setPixel(raster, x, y, c);
  };

  lines.forEach((line, row) => {
    [...line].forEach((char, col) => {
      const glyph = decoded.get(char) ?? decoded.get(char.toLowerCase());
      const originX = pad + col * cellW;
      const originY = pad + row * cellH;
      if (!glyph) return;
      for (let dy = 0; dy < FONT_HEIGHT; dy++) {
        for (let dx = 0; dx < FONT_WIDTH; dx++) {
          if (!(glyph[dy] & (1 << (FONT_WIDTH - 1 - dx)))) continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              put(originX + dx * scale + sx, originY + dy * scale + sy, color);
            }
          }
        }
      }
      if (outline > 0) {
        const outlineColor = options.outlineColor ?? { r: 255, g: 255, b: 255, a: 255 };
        const marks: { dx: number; dy: number }[] = [];
        for (let dy = 0; dy < FONT_HEIGHT; dy++) {
          for (let dx = 0; dx < FONT_WIDTH; dx++) {
            if (!(glyph[dy] & (1 << (FONT_WIDTH - 1 - dx)))) continue;
            for (let oy = -outline; oy <= outline; oy++) {
              for (let ox = -outline; ox <= outline; ox++) {
                if (ox === 0 && oy === 0) continue;
                if (Math.abs(ox) + Math.abs(oy) > outline + 1) continue;
                marks.push({ dx: dx * scale + ox * scale, dy: dy * scale + oy * scale });
                marks.push({ dx: dx * scale + ox, dy: dy * scale + oy });
              }
            }
          }
        }
        for (const mark of marks) {
          put(originX + mark.dx, originY + mark.dy, outlineColor);
        }
      }
    });
  });
  return raster;
}
