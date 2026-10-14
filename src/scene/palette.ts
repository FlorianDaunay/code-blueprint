import { Color } from "three";
import type { Lang, PatternVerdict, Severity } from "../core/model";
import { mix, parseColor } from "../themes/color";
import type { Theme } from "../themes/types";

/**
 * Scene colours. UI chrome follows the theme; map illustration colours (languages) are a fixed,
 * colour-blind-checked categorical palette so a repo looks the same in every theme.
 */
const LANG_HEX: Record<Lang, string> = {
  typescript: "#3FA9FF",
  javascript: "#F5D547",
  python: "#4ADE80",
  java: "#FF8A3D",
  kotlin: "#B07CFF",
  csharp: "#2EE6D6",
  go: "#5BD3FF",
  php: "#8E9BFF",
  other: "#8892A6",
};

export const langHex = (lang: Lang) => LANG_HEX[lang];

const opaque = (hex: string, over: string) => {
  const c = parseColor(hex);
  return c.a >= 1 ? hex.slice(0, 7) : mix(over.slice(0, 7), hex.slice(0, 7), c.a);
};

export interface ScenePalette {
  background: Color;
  fog: Color;
  grid: Color;
  gridMajor: Color;
  platform: (level: number) => Color;
  platformEdge: Color;
  neutral: Color;
  dim: Color;
  accent: Color;
  /** "used by" arcs. */
  incoming: Color;
  severity: Record<Severity | "none", Color>;
  verdict: Record<PatternVerdict, Color>;
  lang: (lang: Lang) => Color;
  heat: (t: number) => Color;
  dark: boolean;
}

export function scenePalette(theme: Theme): ScenePalette {
  const c = theme.colors;
  const dark = theme.scheme === "dark";
  const canvas = opaque(c.canvas, "#000000");
  const surface = opaque(c.surface, canvas);
  const accent = opaque(c.accent, canvas);
  const heatStops = [new Color("#1F4E8C"), new Color("#2EE6D6"), new Color("#F5D547"), new Color("#FF4D6D")];
  return {
    dark,
    background: new Color(canvas),
    fog: new Color(canvas),
    grid: new Color(mix(canvas, accent, dark ? 0.12 : 0.18)),
    gridMajor: new Color(mix(canvas, accent, dark ? 0.28 : 0.35)),
    platform: (level) => new Color(mix(mix(canvas, surface, 0.9), accent, Math.min(0.32, 0.07 + level * 0.05))),
    platformEdge: new Color(mix(canvas, accent, 0.65)),
    neutral: new Color(mix(canvas, dark ? "#9FB3C8" : "#41536B", 0.75)),
    dim: new Color(mix(canvas, dark ? "#FFFFFF" : "#000000", 0.07)),
    accent: new Color(accent),
    incoming: new Color("#FF5FD2"),
    severity: {
      none: new Color(mix(canvas, opaque(c.success, canvas), 0.55)),
      info: new Color("#7AA2FF"),
      warning: new Color(opaque(c.warning, canvas)),
      error: new Color(opaque(c.danger, canvas)),
    },
    verdict: {
      complete: new Color(opaque(c.success, canvas)),
      partial: new Color(opaque(c.warning, canvas)),
      flawed: new Color(opaque(c.danger, canvas)),
    },
    lang: (lang) => new Color(LANG_HEX[lang]),
    heat: (t) => {
      const x = Math.max(0, Math.min(1, t)) * (heatStops.length - 1);
      const i = Math.min(heatStops.length - 2, Math.floor(x));
      return heatStops[i].clone().lerp(heatStops[i + 1], x - i);
    },
  };
}
