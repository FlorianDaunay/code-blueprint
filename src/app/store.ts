import type { Analysis } from "../core/model";
import type { CityLayout } from "../core/layout";
import type { Derived } from "./derived";

export type Lens = "structure" | "health" | "patterns" | "coupling";

export type Selection =
  | { kind: "file"; id: number }
  | { kind: "dir"; path: string }
  | { kind: "issue"; id: string }
  | { kind: "pattern"; id: string }
  | null;

export type Panel = "none" | "inspector" | "issues" | "patterns" | "settings" | "help";

export interface AppState {
  analysis: Analysis | null;
  layout: CityLayout | null;
  derived: Derived | null;
  lens: Lens;
  selection: Selection;
  hover: number | null;
  panel: Panel;
  /** Show aggregated dependency arcs when nothing is selected. */
  allArcs: boolean;
  iso: boolean;
  glow: boolean;
}

type Listener = (state: AppState, prev: AppState) => void;

/** A tiny observable store (no framework needed for this amount of state). */
export class Store {
  private listeners = new Set<Listener>();
  constructor(public state: AppState) {}

  set(patch: Partial<AppState>) {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const l of this.listeners) l(this.state, prev);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

const PREFS = "code-blueprint-prefs";

export function loadPrefs(): Pick<AppState, "lens" | "allArcs" | "iso" | "glow"> {
  const defaults = { lens: "structure" as Lens, allArcs: false, iso: false, glow: true };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(PREFS) ?? "{}") as object) };
  } catch {
    return defaults;
  }
}

export function savePrefs(state: AppState) {
  try {
    const { lens, allArcs, iso, glow } = state;
    localStorage.setItem(PREFS, JSON.stringify({ lens, allArcs, iso, glow }));
  } catch {
    // Preferences are a convenience only.
  }
}
