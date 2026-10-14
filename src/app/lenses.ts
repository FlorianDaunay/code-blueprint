import { Color } from "three";
import type { Analysis, Lang } from "../core/model";
import { LANG_LABEL } from "../core/languages";
import type { ScenePalette } from "../scene/palette";
import type { Derived } from "./derived";
import type { Lens } from "./store";
import type { IconName } from "../ui/icons";

export interface LensInfo {
  id: Lens;
  label: string;
  icon: IconName;
  key: string;
}

export const LENSES: LensInfo[] = [
  { id: "structure", label: "Structure · languages", icon: "structure", key: "1" },
  { id: "health", label: "Health · rule violations", icon: "health", key: "2" },
  { id: "patterns", label: "Design patterns", icon: "patterns", key: "3" },
  { id: "coupling", label: "Coupling heat", icon: "coupling", key: "4" },
];

export interface LegendEntry {
  color: string;
  label: string;
}

export interface LensPaint {
  color: (file: number) => Color;
  pulse: (file: number) => number;
  legend: LegendEntry[];
}

const hex = (c: Color) => `#${c.getHexString()}`;

export function paintLens(lens: Lens, a: Analysis, d: Derived, p: ScenePalette): LensPaint {
  const ghost = p.neutral.clone().lerp(p.background, 0.55);
  switch (lens) {
    case "structure": {
      const cache = new Map<Lang, Color>();
      const langColor = (l: Lang) => cache.get(l) ?? cache.set(l, p.lang(l)).get(l)!;
      const present = [...new Set(a.files.map((f) => f.lang))].sort((x, y) => a.files.filter((f) => f.lang === y).length - a.files.filter((f) => f.lang === x).length);
      return {
        color: (f) => {
          const file = a.files[f];
          const c = langColor(file.lang);
          return file.analyzed || file.lang === "other" ? c : c.clone().lerp(p.background, 0.45);
        },
        pulse: () => 0,
        legend: present.slice(0, 7).map((l) => ({ color: hex(langColor(l)), label: LANG_LABEL[l] })),
      };
    }
    case "health":
      return {
        color: (f) => {
          const s = d.worstSeverity[f];
          return s ? p.severity[s] : ghost;
        },
        pulse: (f) => (d.worstSeverity[f] === "error" ? 0.55 : 0),
        legend: [
          { color: hex(p.severity.error), label: "error" },
          { color: hex(p.severity.warning), label: "warning" },
          { color: hex(p.severity.info), label: "info" },
          { color: hex(ghost), label: "clean" },
        ],
      };
    case "patterns":
      return {
        color: (f) => {
          const v = d.worstVerdict[f];
          return v ? p.verdict[v] : ghost;
        },
        pulse: () => 0,
        legend: [
          { color: hex(p.verdict.complete), label: "complete" },
          { color: hex(p.verdict.partial), label: "partial" },
          { color: hex(p.verdict.flawed), label: "flawed" },
        ],
      };
    case "coupling": {
      const max = Math.log(d.maxDegree + 1);
      return {
        color: (f) => p.heat(Math.log(d.outgoing[f].length + d.incoming[f].length + 1) / max),
        pulse: () => 0,
        legend: [
          { color: hex(p.heat(0)), label: "isolated" },
          { color: hex(p.heat(0.5)), label: "" },
          { color: hex(p.heat(1)), label: "hub" },
        ],
      };
    }
  }
}
