import type { Rgba } from "../types.js";

const NAMED: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  teal: "#008080",
  navy: "#000080",
  purple: "#800080",
  orange: "#ffa500",
  amber: "#ffbf00",
  gold: "#ffd700",
  pink: "#ffc0cb",
  rose: "#ff007f",
  crimson: "#dc143c",
  coral: "#ff7f50",
  salmon: "#fa8072",
  tomato: "#ff6347",
  khaki: "#f0e68c",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  linen: "#faf0e6",
  chocolate: "#d2691e",
  sienna: "#a0522d",
  brown: "#a52a2a",
  tan: "#d2b48c",
  peru: "#cd853f",
  sandy: "#f4a460",
  peach: "#ffe5b4",
  apricot: "#fbceb1",
  cream: "#fffdd0",
  wheat: "#f5deb3",
  corn: "#fbec5d",
  lemon: "#fff44f",
  mustard: "#ffdb58",
  butter: "#ffeead",
  mint: "#98ff98",
  sage: "#9caf88",
  moss: "#8a9a5b",
  avocado: "#568203",
  leaf: "#579d1c",
  grass: "#7cfc00",
  emerald: "#50c878",
  jade: "#00a86b",
  forest: "#228b22",
  pine: "#01796f",
  ocean: "#006994",
  sky: "#87ceeb",
  azure: "#007fff",
  cerulean: "#2a52be",
  denim: "#1560bd",
  indigo: "#4b0082",
  royal: "#4169e1",
  cobalt: "#0047ab",
  steel: "#b0bec5",
  slate: "#708090",
  midnight: "#191970",
  charcoal: "#36454f",
  gunmetal: "#2a3439",
  ash: "#b2beb5",
  smoke: "#738276",
  stone: "#928e85",
  sand: "#c2b280",
  dirt: "#8b6d4a",
  wood: "#7c4a21",
  coffee: "#6f4e37",
  rust: "#b7410e",
  brick: "#cb4154",
  wine: "#722f37",
  plum: "#8e4585",
  lavender: "#e6e6fa",
  lilac: "#c8a2c8",
  violet: "#8f00ff",
  mauve: "#e0b0ff",
  heather: "#a269c4",
  orchid: "#da70d6",
  berry: "#8e3b52",
  cherry: "#de3163",
  ruby: "#e0115f",
  garnet: "#733635",
  rose_gold: "#b76e79",
  copper: "#b87333",
  bronze: "#cd7f32",
  brass: "#b5a642",
  silver2: "#cccccc",
  platinum: "#e5e4e2",
  neon: "#39ff14",
  hotpink: "#ff69b4",
  electric: "#ccff00",
  ice: "#d6faff",
  snow: "#fffafa",
  fog: "#d7d7d7",
  cloud: "#c4c4c4",
  pearl: "#eae0c8",
  eggshell: "#f0ead6",
  parchment: "#e8d9b5",
  paper: "#fcf5e3",
  canvas: "#f1e8d0",
  burlap: "#c9b27c",
  denim_dark: "#1d3557",
  navy_blue: "#0a1f44",
  petrol: "#004e59",
  lagoon: "#00a3a1",
  turquoise: "#40e0d0",
  aquamarine: "#7fffd4",
  sea: "#3a9188",
  deepsea: "#0b5f6b",
  blood: "#63050f",
  fire: "#e25822",
  flame: "#ff7b00",
  ember: "#ff4500",
  sunset: "#f74646",
  sunrise: "#ff9e6d",
  dusk: "#4a3b6b",
  night: "#0d0d2b",
  cosmic: "#2b2b4a",
  galaxy: "#5f507c",
  purple_rain: "#6a0dad",
  amethyst: "#9966cc",
  sapphire: "#0f52ba",
  topaz: "#ffc87c",
  peridot: "#e6d62a",
  opal: "#a8c3dd",
  onyx: "#353839",
};

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clamp255(a) };
}

export function toRgba(value: Rgba | readonly number[] | string): Rgba {
  if (typeof value === "string") return parseColor(value);
  if (Array.isArray(value)) {
    const list = value as readonly number[];
    return rgba(list[0] ?? 0, list[1] ?? 0, list[2] ?? 0, list[3] ?? 255);
  }
  const channels = value as Rgba;
  return rgba(channels.r, channels.g, channels.b, channels.a ?? 255);
}

/** Alpha-blend `src` over `dst`, both premultiplied-free, 8-bit channels. */
export function blendOver(src: Rgba, dst: Rgba): Rgba {
  const sa = src.a / 255;
  const da = dst.a / 255;
  const out = sa + da * (1 - sa);
  if (out <= 0) return rgba(0, 0, 0, 0);
  const ch = (s: number, d: number): number => (s * sa + d * da * (1 - sa)) / out;
  return rgba(ch(src.r, dst.r), ch(src.g, dst.g), ch(src.b, dst.b), out * 255);
}

export function lerpColor(a: Rgba, b: Rgba, t: number): Rgba {
  const k = Math.max(0, Math.min(1, t));
  return rgba(
    a.r + (b.r - a.r) * k,
    a.g + (b.g - a.g) * k,
    a.b + (b.b - a.b) * k,
    a.a + (b.a - a.a) * k,
  );
}

export function toHex(c: Rgba, includeAlpha = true): string {
  const h = (n: number): string => clamp255(n).toString(16).padStart(2, "0");
  const alpha = includeAlpha || c.a < 255 ? h(c.a) : "";
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${alpha}`;
}

export function toCss(c: Rgba): string {
  return c.a >= 255 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;
}

function hueToRgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

export function fromHsl(h: number, s: number, l: number, a = 1): Rgba {
  const hh = ((h % 360) + 360) / 360 % 1;
  const ss = Math.max(0, Math.min(1, s));
  const ll = Math.max(0, Math.min(1, l));
  if (ss === 0) return rgba(ll * 255, ll * 255, ll * 255, a * 255);
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  return rgba(
    hueToRgb(p, q, hh + 1 / 3) * 255,
    hueToRgb(p, q, hh) * 255,
    hueToRgb(p, q, hh - 1 / 3) * 255,
    a * 255,
  );
}

function parseNums(inner: string): number[] {
  return inner
    .split(/[,/\s]+/)
    .filter((s) => s.length > 0)
    .map((s) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s)));
}

/**
 * Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()`, `hsl()/hsla()`,
 * `name`, `name:N` (palette pick) and `h:70 s:60 l:50` shorthand.
 */
export function parseColor(input: string): Rgba {
  const text = input.trim().toLowerCase();
  if (!text) throw new Error("Empty color string");

  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`Bad hex color "${input}"`);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) : 255;
      return rgba(r, g, b, a);
    }
    if (hex.length === 6 || hex.length === 8) {
      return rgba(
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
      );
    }
    throw new Error(`Hex color must be 3/4/6/8 digits, got "${input}"`);
  }

  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(text);
  if (fn) {
    const parts = parseNums(fn[2]);
    if (fn[1].startsWith("rgb")) {
      if (parts.length < 3) throw new Error(`rgb() needs 3 numbers, got "${input}"`);
      // css alpha is 0..1; tolerate a 0..255 fourth value too
      const alpha = parts[3] === undefined ? 255 : parts[3] <= 1 ? parts[3] * 255 : parts[3];
      return rgba(parts[0], parts[1], parts[2], alpha);
    }
    if (parts.length < 3) throw new Error(`hsl() needs 3 numbers, got "${input}"`);
    const alpha = parts[3] ?? 1;
    return fromHsl(parts[0], parts[1] > 1 ? parts[1] / 100 : parts[1], parts[2] > 1 ? parts[2] / 100 : parts[2], alpha);
  }

  // h:210 s:80% l:50% style
  const hslish = /h\s*:?\s*([\d.]+)[\s,]+s\s*:?\s*([\d.]+)(%?)[\s,]+l\s*:?\s*([\d.]+)(%?)/.exec(text);
  if (hslish) {
    return fromHsl(
      parseFloat(hslish[1]),
      parseFloat(hslish[2]) / 100,
      parseFloat(hslish[4]) / 100,
    );
  }

  // gray-ish shortcuts: "gray40" / "grey-40" => 40% luminance
  const shade = /^(?:gray|grey)[-_]?(\d{1,3})$/.exec(text);
  if (shade) {
    const v = Math.min(100, parseInt(shade[1], 10)) * 2.55;
    return rgba(v, v, v);
  }

  const named = NAMED[text] ?? NAMED[text.replace(/[\s-]+/g, "_")];
  if (named) return parseColor(named);

  throw new Error(
    `Unknown color "${input}". Use #hex, rgb(), hsl(), a name (${Object.keys(NAMED).slice(0, 12).join(", ")} …), or pass {r,g,b,a}.`,
  );
}

export const PALETTE_NAMES = Object.keys(NAMED);

export function colorDistance(a: Rgba, b: Rgba): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) + Math.abs(a.a - b.a);
}

export { clamp255 };
