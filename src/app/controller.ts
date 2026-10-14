import { Color, Vector3 } from "three";
import type { Analysis } from "../core/model";
import type { Arc } from "../scene/arcs";
import { CityView, TowerState } from "../scene/city";
import type { ScenePalette } from "../scene/palette";
import { Labels } from "../ui/labels";
import { paintLens, type LensPaint } from "./lenses";
import type { AppState, Store } from "./store";

const MAX_FOCUS_ARCS = 400;

/** Keeps the 3D city in sync with the app state (lens colours, focus, arcs, camera). */
export class Controller {
  paint: LensPaint | null = null;
  private aggregated: Arc[] = [];

  constructor(
    private store: Store,
    readonly city: CityView,
    readonly labels: Labels,
    private palette: ScenePalette,
  ) {
    store.subscribe((s, prev) => this.sync(s, prev));
  }

  setPalette(p: ScenePalette) {
    this.palette = p;
    this.city.applyPalette(p);
    const s = this.store.state;
    if (s.analysis) {
      this.aggregated = this.buildAggregatedArcs(s.analysis);
      this.recolor(s);
      this.refocus(s);
    }
  }

  private sync(s: AppState, prev: AppState) {
    const newCity = s.layout !== prev.layout;
    if (newCity && s.layout && s.analysis) {
      this.city.load(s.layout);
      this.aggregated = this.buildAggregatedArcs(s.analysis);
      this.labels.setDirs(
        s.layout.platforms
          .filter((p) => p.level >= 1)
          .map((p) => {
            const dir = s.analysis!.dirs.find((d) => d.path === p.dir);
            return { text: dir?.name ?? p.dir, pos: new Vector3(p.x - p.w / 2 + 0.6, p.y + 0.3, p.z + p.d / 2 - 0.4), width: p.w, level: p.level };
          }),
      );
    }
    if (newCity || s.lens !== prev.lens || s.diff !== prev.diff) this.recolor(s);
    if (newCity || s.selection !== prev.selection || s.hover !== prev.hover || s.allArcs !== prev.allArcs || s.lens !== prev.lens || s.diff !== prev.diff) this.refocus(s);
    if (s.selection !== prev.selection && s.selection) this.flyToSelection(s);
    if (s.iso !== this.city.isometric) this.city.setIsometric(s.iso);
    if (s.glow !== this.city.bloomEnabled) this.city.setBloom(s.glow);
  }

  private recolor(s: AppState) {
    if (!s.analysis || !s.derived) return;
    this.paint = paintLens(s.lens, s.analysis, s.derived, this.palette, s.diff);
    this.city.setTowerColors(this.paint.color, this.paint.pulse);
  }

  /** Focus set, dimming and arcs for the current selection (or hover). */
  private refocus(s: AppState) {
    const a = s.analysis;
    const d = s.derived;
    if (!a || !d) return;
    const sel = s.selection;
    const p = this.palette;
    const arcs: Arc[] = [];
    const fileArc = (from: number, to: number, color: Color, alpha: number) => {
      const f = this.city.towerTop(from);
      const t = this.city.towerTop(to);
      if (f && t) arcs.push({ from: f, to: t, color, alpha });
    };
    let highlight: Set<number> | null = null;
    let primary: number | null = null;
    let dirFocus: string | null = null;
    const focusLabels: { text: string; pos: Vector3; primary: boolean }[] = [];

    if (!sel) {
      if (s.hover !== null) {
        for (const t of d.outgoing[s.hover].slice(0, MAX_FOCUS_ARCS)) fileArc(s.hover, t, p.accent, 0.55);
        for (const f of d.incoming[s.hover].slice(0, MAX_FOCUS_ARCS)) fileArc(f, s.hover, p.incoming, 0.55);
      } else if (s.lens === "diff" && s.diff) {
        // What changed in the dependency graph: new links in green, vanished ones in red.
        for (const [f, t] of s.diff.addedEdges.slice(0, MAX_FOCUS_ARCS)) fileArc(f, t, p.verdict.complete, 0.85);
        for (const [f, t] of s.diff.removedEdges.slice(0, MAX_FOCUS_ARCS)) fileArc(f, t, p.verdict.flawed, 0.85);
      } else if (s.allArcs) arcs.push(...this.aggregated);
    } else if (sel.kind === "file") {
      primary = sel.id;
      highlight = new Set([sel.id, ...d.outgoing[sel.id], ...d.incoming[sel.id]]);
      for (const t of d.outgoing[sel.id].slice(0, MAX_FOCUS_ARCS)) fileArc(sel.id, t, p.accent, 0.9);
      for (const f of d.incoming[sel.id].slice(0, MAX_FOCUS_ARCS)) fileArc(f, sel.id, p.incoming, 0.9);
      // Diff: links this file lost since the base ref (all of them for a removed file).
      for (const [f, t] of s.diff?.removedEdges ?? []) {
        if (f !== sel.id && t !== sel.id) continue;
        highlight.add(f === sel.id ? t : f);
        fileArc(f, t, p.verdict.flawed, 0.9);
      }
    } else if (sel.kind === "dir") {
      dirFocus = sel.path;
      const inside = new Set(d.filesUnder.get(sel.path) ?? []);
      highlight = inside;
      let n = 0;
      for (const f of inside) {
        for (const t of d.outgoing[f]) if (!inside.has(t) && n++ < MAX_FOCUS_ARCS) fileArc(f, t, p.accent, 0.6);
        for (const o of d.incoming[f]) if (!inside.has(o) && n++ < MAX_FOCUS_ARCS * 2) fileArc(o, f, p.incoming, 0.6);
      }
    } else if (sel.kind === "issue") {
      const issue = d.issueById.get(sel.id);
      if (issue) {
        highlight = new Set(issue.files);
        primary = issue.files[0] ?? null;
        for (const dir of issue.dirs) for (const f of d.filesUnder.get(dir) ?? []) highlight.add(f);
        for (const [f, t] of issue.edges.slice(0, MAX_FOCUS_ARCS)) fileArc(f, t, p.severity[issue.severity], 1);
        if (issue.dirs.length === 1 && !issue.files.length) dirFocus = issue.dirs[0];
      }
    } else if (sel.kind === "pattern") {
      const m = d.patternById.get(sel.id);
      if (m) {
        highlight = new Set(m.files);
        primary = m.roles[0]?.types[0]?.file ?? null;
        const color = p.verdict[m.verdict];
        if (primary !== null) for (const f of m.files) if (f !== primary) fileArc(primary, f, color, 1);
        for (const role of m.roles) for (const t of role.types.slice(0, 8)) {
          const pos = this.city.towerTop(t.file);
          if (pos) focusLabels.push({ text: `${role.role} · ${t.name}`, pos: pos.add(new Vector3(0, 0.6, 0)), primary: t.file === primary });
        }
      }
    }

    // Removed files (diff) are ghosts unless they are part of the focus.
    const removed = (f: number) => s.diff?.status[f] === "removed";
    this.city.setTowerStates((f) => (f === primary ? TowerState.Selected : highlight ? (highlight.has(f) ? (removed(f) ? TowerState.Ghost : TowerState.Highlight) : TowerState.Dim) : removed(f) ? TowerState.Ghost : TowerState.Normal));
    this.city.setPlatformStates((dir) => (dirFocus !== null && (dir === dirFocus) ? TowerState.Highlight : TowerState.Normal));
    this.city.setArcs(arcs);

    // Name tags for the focus set (files) when it is small enough to read.
    if (sel && sel.kind !== "pattern" && highlight && highlight.size <= 40) {
      for (const f of highlight) {
        const pos = this.city.towerTop(f);
        if (pos) focusLabels.push({ text: a.files[f].name, pos: pos.add(new Vector3(0, 0.6, 0)), primary: f === primary });
      }
    } else if (primary !== null && sel?.kind !== "pattern") {
      const pos = this.city.towerTop(primary);
      if (pos) focusLabels.push({ text: a.files[primary].name, pos: pos.add(new Vector3(0, 0.6, 0)), primary: true });
    }
    this.labels.setFocus(focusLabels);
  }

  private flyToSelection(s: AppState) {
    const sel = s.selection;
    const d = s.derived;
    if (!sel || !d) return;
    if (sel.kind === "file") {
      const b = this.city.boundsOfFiles([sel.id]);
      if (b) this.city.flyTo(b, true, 26);
    } else if (sel.kind === "dir") {
      const b = this.city.boundsOfDir(sel.path);
      if (b) this.city.flyTo(b);
    } else {
      const files = sel.kind === "issue" ? d.issueById.get(sel.id)?.files : d.patternById.get(sel.id)?.files;
      const dirs = sel.kind === "issue" ? d.issueById.get(sel.id)?.dirs ?? [] : [];
      const b = files?.length ? this.city.boundsOfFiles(files) : dirs.length ? this.city.boundsOfDir(dirs[0]) : null;
      if (b) this.city.flyTo(b, true, 12);
    }
  }

  /** Directory-to-directory arcs at the shallowest level that splits the repo into ≥ 6 parts. */
  private buildAggregatedArcs(a: Analysis): Arc[] {
    const layout = this.store.state.layout;
    if (!layout) return [];
    let level = 1;
    for (; level < 4; level++) if (layout.platforms.filter((p) => p.level === level).length >= 6) break;
    const groups = new Map<string, string | undefined>(); // dir path → group platform dir
    // Walking up from a file's directory, the first platform at or above `level` is its group.
    const groupOf = (dir: string): string | undefined => {
      if (groups.has(dir)) return groups.get(dir);
      let p = dir;
      let found: string | undefined;
      for (;;) {
        const pl = layout.platformByDir.get(p);
        if (pl && pl.level <= level) {
          found = pl.level > 0 ? pl.dir : undefined;
          break;
        }
        if (p === "") break;
        p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      }
      groups.set(dir, found);
      return found;
    };
    const counts = new Map<string, number>();
    for (const e of a.edges) {
      const ga = groupOf(a.files[e.from].dir);
      const gb = groupOf(a.files[e.to].dir);
      if (ga === undefined || gb === undefined || ga === gb) continue;
      const key = `${ga}\u0000${gb}`;
      counts.set(key, (counts.get(key) ?? 0) + e.weight);
    }
    const max = Math.max(1, ...counts.values());
    const arcs: Arc[] = [];
    for (const [key, w] of [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 600)) {
      const [ga, gb] = key.split("\u0000");
      const from = layout.platformByDir.get(ga);
      const to = layout.platformByDir.get(gb);
      if (!from || !to) continue;
      arcs.push({ from: new Vector3(from.x, from.y + 0.4, from.z), to: new Vector3(to.x, to.y + 0.4, to.z), color: this.palette.accent, alpha: 0.35 + 0.65 * (Math.log(w + 1) / Math.log(max + 1)) });
    }
    return arcs;
  }
}
