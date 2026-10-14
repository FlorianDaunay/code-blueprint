import type { Analysis, Progress } from "../core/model";
import { LANG_LABEL } from "../core/languages";
import { LENSES, type LegendEntry } from "../app/lenses";
import type { AppState, Lens, Panel } from "../app/store";
import { langHex } from "../scene/palette";
import { scopeTheme, themes, themeStore } from "../themes";
import { clear, fmt, h, icon, iconButton } from "./dom";

// ---------------------------------------------------------------- Landing
const EXAMPLES = [
  { repo: "RefactoringGuru/design-patterns-typescript", tag: "patterns" },
  { repo: "expressjs/express", tag: "js" },
  { repo: "pallets/flask", tag: "python" },
  { repo: "spring-projects/spring-petclinic", tag: "java" },
  { repo: "gin-gonic/gin", tag: "go" },
  { repo: "iluwatar/java-design-patterns", tag: "large" },
];

const RECENT = "code-blueprint-recent";

export function rememberRepo(input: string) {
  try {
    const list = (JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[]).filter((r) => r.toLowerCase() !== input.toLowerCase());
    localStorage.setItem(RECENT, JSON.stringify([input, ...list].slice(0, 6)));
  } catch {
    // ignore
  }
}

function recentRepos(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function landing(onSubmit: (input: string) => void): HTMLElement {
  const input = h("input.repo-input", { type: "text", placeholder: "owner/repo or GitHub URL", spellcheck: "false", autocomplete: "off", "aria-label": "Public GitHub repository" });
  const form = h(
    "form.repo-form",
    { onsubmit: (e: Event) => { e.preventDefault(); if (input.value.trim()) onSubmit(input.value.trim()); } },
    icon("github", 20, "muted"),
    input,
    h("button.go", { type: "submit", "aria-label": "Map it" }, icon("arrow", 20)),
  );
  const chip = (repo: string, tag?: string) => h("button.example", { type: "button", onclick: () => onSubmit(repo) }, repo, tag ? h("small", tag) : null);
  const recent = recentRepos();
  const el = h(
    "section.landing",
    h("div.landing-inner",
      h("div.brand", icon("logo", 44), h("h1", "code", h("span", "·"), "blueprint")),
      h("p.tagline", "Any public repo, as a living 3D map."),
      form,
      h("div.examples", ...(recent.length ? recent.map((r) => chip(r)) : []), ...EXAMPLES.filter((e) => !recent.includes(e.repo)).slice(0, 6 - Math.min(3, recent.length)).map((e) => chip(e.repo, e.tag))),
      h("div.legend-hero",
        h("span", icon("structure", 16), "towers = files"),
        h("span", icon("layers", 16), "platforms = folders"),
        h("span", icon("arcs", 16), "arcs = dependencies"),
      ),
    ),
  );
  queueMicrotask(() => input.focus());
  return el;
}

// ---------------------------------------------------------------- Loader
const PHASES: { id: Progress["phase"]; label: string }[] = [
  { id: "meta", label: "repository" },
  { id: "tree", label: "file tree" },
  { id: "fetch", label: "sources" },
  { id: "analyze", label: "analysis" },
];

export class Loader {
  readonly el = h("section.loader", { role: "status" });
  private ring = h("div.ring");
  private value = h("b", "");
  private steps = h("ol.steps");
  private title = h("p.loader-repo");

  constructor(onCancel: () => void) {
    this.el.append(h("div.loader-inner", this.title, h("div.ring-wrap", this.ring, this.value), this.steps, h("button.ghost", { type: "button", onclick: onCancel }, icon("close", 14), "cancel")));
  }

  start(repo: string) {
    this.title.textContent = repo;
    this.update({ phase: "meta" });
    this.el.classList.add("open");
  }

  update(p: Progress) {
    const idx = Math.max(0, PHASES.findIndex((x) => x.id === p.phase));
    clear(this.steps);
    PHASES.forEach((ph, i) => this.steps.append(h(`li${i < idx ? ".done" : i === idx ? ".active" : ""}`, ph.label)));
    const pct = p.phase === "fetch" ? p.done / Math.max(1, p.total) : p.phase === "analyze" ? 1 : p.phase === "cache" ? 1 : 0;
    this.ring.style.setProperty("--p", String(pct));
    this.ring.classList.toggle("spin", p.phase !== "fetch");
    this.value.textContent = p.phase === "fetch" ? `${p.done}/${p.total}` : p.phase === "cache" ? "cache" : "";
  }

  hide() {
    this.el.classList.remove("open");
  }
}

// ---------------------------------------------------------------- Error
export function errorCard(message: string, detail: string, onRetry: () => void, onHome: () => void): HTMLElement {
  return h("section.error-card", h("div.error-inner", icon("warning", 34), h("h2", message), detail ? h("p", detail) : null, h("div.row-actions", h("button.btn", { type: "button", onclick: onRetry }, icon("refresh", 16), "Retry"), h("button.ghost", { type: "button", onclick: onHome }, icon("home", 16), "Home"))));
}

// ---------------------------------------------------------------- HUD
export interface HudActions {
  home(): void;
  lens(l: Lens): void;
  panel(p: Panel): void;
  toggleArcs(): void;
  toggleIso(): void;
  resetView(): void;
  search(): void;
}

export class Hud {
  readonly top = h("header.hud-top");
  readonly lensBar = h("nav.lens-bar", { "aria-label": "Lenses" });
  readonly legend = h("div.legend");
  private lensButtons = new Map<Lens, HTMLButtonElement>();
  private arcsBtn: HTMLButtonElement;
  private isoBtn: HTMLButtonElement;
  private issuesBadge = h("span.badge");
  private patternsBadge = h("span.badge");

  constructor(private act: HudActions) {
    for (const l of LENSES) {
      const b = iconButton(l.icon, `${l.label}  [${l.key}]`, () => act.lens(l.id), "lens");
      this.lensButtons.set(l.id, b);
      this.lensBar.append(b);
    }
    this.lensBar.append(h("span.sep"));
    this.arcsBtn = iconButton("arcs", "All dependencies  [A]", () => act.toggleArcs());
    this.isoBtn = iconButton("iso", "Isometric view  [I]", () => act.toggleIso());
    this.lensBar.append(this.arcsBtn, this.isoBtn, iconButton("target", "Reset view  [R]", () => act.resetView()));
  }

  render(s: AppState) {
    const a = s.analysis;
    clear(this.top);
    if (!a) return;
    const stat = (iconName: Parameters<typeof icon>[0], value: string, tip: string) => h("span.stat", { "data-tip": tip }, icon(iconName, 15), value);
    this.issuesBadge.textContent = String(a.issues.filter((i) => i.severity !== "info").length);
    this.issuesBadge.className = `badge ${a.issues.some((i) => i.severity === "error") ? "err" : a.issues.length ? "warn" : "ok"}`;
    this.patternsBadge.textContent = String(a.patterns.length);
    const issuesBtn = h("button.hud-btn", { type: "button", "data-tip": "Health findings", "aria-label": "Health findings", onclick: () => this.act.panel(s.panel === "issues" ? "none" : "issues") }, icon("health", 18), this.issuesBadge);
    const patternsBtn = h("button.hud-btn", { type: "button", "data-tip": "Design patterns", "aria-label": "Design patterns", onclick: () => this.act.panel(s.panel === "patterns" ? "none" : "patterns") }, icon("patterns", 18), this.patternsBadge);
    issuesBtn.classList.toggle("active", s.panel === "issues");
    patternsBtn.classList.toggle("active", s.panel === "patterns");
    this.top.append(
      h("button.brand-mini", { type: "button", onclick: () => this.act.home(), "aria-label": "Home", "data-tip": "Home" }, icon("logo", 22)),
      h("a.repo-chip", { href: `https://github.com/${a.repo.owner}/${a.repo.repo}`, target: "_blank", rel: "noopener" }, h("span", a.repo.owner + " / "), h("b", a.repo.repo), a.repo.path ? h("span", " / " + a.repo.path) : null, h("small", a.repo.ref)),
      h("div.stats", stat("file", fmt(a.stats.files), `${a.stats.files} files (${a.stats.analyzedFiles} analyzed)`), stat("lines", fmt(a.stats.loc), "lines of code"), stat("arcs", fmt(a.stats.edges), "dependencies")),
      h("div.spacer"),
      issuesBtn,
      patternsBtn,
      iconButton("search", "Search  [/]", () => this.act.search()),
      iconButton("settings", "Settings", () => this.act.panel(s.panel === "settings" ? "none" : "settings")),
      iconButton("help", "How to read the map  [?]", () => this.act.panel(s.panel === "help" ? "none" : "help")),
    );
    for (const [l, b] of this.lensButtons) b.classList.toggle("active", l === s.lens);
    this.arcsBtn.classList.toggle("active", s.allArcs);
    this.isoBtn.classList.toggle("active", s.iso);
  }

  setLegend(entries: LegendEntry[], lens: Lens) {
    clear(this.legend);
    const lensInfo = LENSES.find((l) => l.id === lens)!;
    this.legend.append(h("span.legend-title", icon(lensInfo.icon, 14)));
    for (const e of entries) this.legend.append(h("span.legend-item", h("i", { style: { background: e.color } }), e.label));
    if (lens === "structure" || lens === "coupling") this.legend.append(h("span.legend-item.arcs", h("i.out"), "uses", h("i.in"), "used by"));
  }
}

// ---------------------------------------------------------------- Tooltip
export class Tooltip {
  readonly el = h("div.tooltip", { role: "tooltip" });
  show(x: number, y: number, content: (Node | null)[]) {
    clear(this.el);
    this.el.append(...content.filter((c): c is Node => !!c));
    this.el.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 14)}px)`;
    this.el.classList.add("open");
  }
  hide() {
    this.el.classList.remove("open");
  }
}

// ---------------------------------------------------------------- Search
export interface SearchItem {
  label: string;
  sub: string;
  kind: "file" | "dir" | "type";
  color?: string;
  run(): void;
}

export class Search {
  readonly el = h("div.search-overlay", { role: "dialog", "aria-label": "Search" });
  private input = h("input.search-input", { type: "text", placeholder: "Find a file, folder or class…", spellcheck: "false", autocomplete: "off" });
  private list = h("ul.search-list");
  private items: SearchItem[] = [];
  private results: SearchItem[] = [];
  private active = 0;

  constructor() {
    this.el.append(h("div.search-box", h("div.search-field", icon("search", 18, "muted"), this.input, h("kbd", "esc")), this.list));
    this.el.addEventListener("pointerdown", (e) => { if (e.target === this.el) this.close(); });
    this.input.addEventListener("input", () => this.filter());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { this.active = Math.min(this.results.length - 1, this.active + 1); this.paint(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { this.active = Math.max(0, this.active - 1); this.paint(); e.preventDefault(); }
      else if (e.key === "Enter") { this.results[this.active]?.run(); this.close(); }
      else if (e.key === "Escape") this.close();
    });
  }

  setAnalysis(a: Analysis, select: (kind: "file" | "dir", key: string | number) => void) {
    this.items = [
      ...a.files.map((f) => ({ label: f.name, sub: f.dir || "/", kind: "file" as const, color: langHex(f.lang), run: () => select("file", f.id) })),
      ...a.dirs.filter((d) => d.path).map((d) => ({ label: d.name, sub: d.path, kind: "dir" as const, run: () => select("dir", d.path) })),
      ...a.files.flatMap((f) => (f.source?.types ?? []).map((t) => ({ label: t.name, sub: `${t.kind} · ${f.path}`, kind: "type" as const, color: langHex(f.lang), run: () => select("file", f.id) }))),
    ];
  }

  open() {
    this.el.classList.add("open");
    this.input.value = "";
    this.filter();
    this.input.focus();
  }

  close() {
    this.el.classList.remove("open");
  }

  get isOpen() {
    return this.el.classList.contains("open");
  }

  private filter() {
    const q = this.input.value.trim().toLowerCase();
    const score = (it: SearchItem) => {
      const l = it.label.toLowerCase();
      if (!q) return 0;
      if (l === q) return 100;
      if (l.startsWith(q)) return 80 - l.length * 0.01;
      if (l.includes(q)) return 60 - l.length * 0.01;
      if (it.sub.toLowerCase().includes(q)) return 30;
      // subsequence
      let i = 0;
      for (const c of l) if (c === q[i]) i++;
      return i === q.length ? 10 : -1;
    };
    this.results = q ? this.items.map((it) => ({ it, s: score(it) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.it) : [];
    this.active = 0;
    this.paint();
  }

  private paint() {
    clear(this.list);
    this.results.forEach((r, i) => {
      const li = h(`li${i === this.active ? ".active" : ""}`, { onclick: () => { r.run(); this.close(); } }, r.kind === "dir" ? icon("folder", 15, "muted") : r.kind === "type" ? icon("type", 15, "muted") : h("span.dot", { style: { background: r.color ?? "" } }), h("span.row-main", r.label, h("small", r.sub)));
      this.list.append(li);
      if (i === this.active) li.scrollIntoView({ block: "nearest" });
    });
  }
}

// ---------------------------------------------------------------- Settings & help
export function settingsPanel(s: AppState, act: { toggleGlow(): void; toggleIso(): void; toggleArcs(): void; reanalyze(): void }): HTMLElement {
  const current = themeStore.active().id;
  const grid = h("div.theme-grid");
  for (const t of themes) {
    const sw = h("button.theme-swatch", { type: "button", "aria-label": t.name, "data-tip": t.name, onclick: () => { themeStore.select(t.id); grid.querySelectorAll(".theme-swatch").forEach((x) => x.classList.toggle("active", x === sw)); } }, h("span.sw-canvas"), h("span.sw-accent"), h("span.sw-name", t.name));
    scopeTheme(sw, t);
    if (t.id === current) sw.classList.add("active");
    grid.append(sw);
  }
  const toggle = (label: string, on: boolean, fn: () => void) => {
    const b = h("button.toggle", { type: "button", role: "switch", "aria-checked": String(on), onclick: () => { fn(); b.setAttribute("aria-checked", b.getAttribute("aria-checked") === "true" ? "false" : "true"); } }, h("span.knob"), label);
    return b;
  };
  const a = s.analysis;
  const root = h("div.panel");
  root.append(
    h("header.panel-head", h("div.panel-icon", icon("settings", 22)), h("div.panel-title", h("h2", "Settings"))),
    h("div.toggles", toggle("Glow", s.glow, act.toggleGlow), toggle("Isometric", s.iso, act.toggleIso), toggle("All dependencies", s.allArcs, act.toggleArcs)),
    h("h3.sub", icon("palette", 15), "Theme"),
    grid,
  );
  if (a) {
    root.append(
      h("h3.sub", icon("info", 15), "This analysis"),
      h("dl.facts",
        h("dt", "commit"), h("dd", h("code", a.repo.sha.slice(0, 10))),
        h("dt", "analyzed"), h("dd", `${a.stats.analyzedFiles} / ${a.stats.files} files`),
        ...a.stats.skipped.flatMap((sk) => [h("dt", "skipped"), h("dd", `${sk.count} · ${sk.reason}`)]),
        h("dt", "languages"), h("dd", Object.entries(a.stats.langs).sort((x, y) => y[1] - x[1]).map(([l, n]) => `${LANG_LABEL[l as keyof typeof LANG_LABEL] ?? l} ${n}`).join(" · ")),
        h("dt", "took"), h("dd", `${(a.stats.durationMs / 1000).toFixed(1)} s`),
        a.stats.treeTruncated ? h("dt", "note") : null, a.stats.treeTruncated ? h("dd", "GitHub truncated the file tree (very large repository).") : null,
      ),
      h("button.btn", { type: "button", onclick: act.reanalyze }, icon("refresh", 16), "Re-analyze (skip cache)"),
    );
    if (a.stats.externals.length) root.append(h("h3.sub", icon("link", 15), "Top external packages"), h("div.chips", ...a.stats.externals.slice(0, 16).map((e) => h("span.chip.ext", `${e.name} · ${e.count}`))));
  }
  root.append(h("p.version", `code-blueprint v${__APP_VERSION__}`));
  return root;
}

export function helpPanel(): HTMLElement {
  const row = (iconName: Parameters<typeof icon>[0], title: string, text: string) => h("div.help-row", icon(iconName, 20), h("div", h("b", title), h("p", text)));
  const key = (k: string, t: string) => h("div.key-row", h("kbd", k), h("span", t));
  return h("div.panel",
    h("header.panel-head", h("div.panel-icon", icon("help", 22)), h("div.panel-title", h("h2", "Reading the map"))),
    row("structure", "Tower = file", "Height grows with code lines, width with the number of members (methods, fields, functions)."),
    row("layers", "Platform = folder", "Nested folders stack up. Click a platform to inspect the folder."),
    row("arcs", "Arc = dependency", "Cyan flows to what a file uses, pink comes from files that use it."),
    row("health", "Health lens", "Fixed rules: cycles, layer violations, oversized files, hubs… Red pulses are errors."),
    row("patterns", "Patterns lens", "Detected design patterns, green complete, amber partial, red flawed. Open one to see what is missing or shouldn't be there."),
    row("coupling", "Coupling lens", "Heat of connections: hubs glow red."),
    h("h3.sub", icon("keyboard", 15), "Keys"),
    h("div.keys", key("1-4", "lenses"), key("/", "search"), key("A", "all dependencies"), key("I", "isometric"), key("R", "reset view"), key("Esc", "back / close")),
  );
}

declare global {
  const __APP_VERSION__: string;
}
