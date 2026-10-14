import type { Analysis, FileNode, Issue, MethodInfo, PatternCheck, PatternMatch, Severity, TypeInfo } from "../core/model";
import { LANG_LABEL } from "../core/languages";
import { PATTERNS, patternInfo } from "../core/patterns/catalog";
import { LIMITS, RULES } from "../core/rules";
import type { Derived } from "../app/derived";
import type { DiffResult } from "../core/diff";
import type { Panel, Selection } from "../app/store";
import { langHex } from "../scene/palette";
import { clear, fmt, h, icon, iconButton } from "./dom";
import type { IconName } from "./icons";

export interface DrawerActions {
  select(sel: Selection): void;
  panel(p: Panel): void;
}

const SEV_ICON: Record<Severity, IconName> = { error: "error", warning: "warning", info: "info" };

export function githubUrl(a: Analysis, path: string, line?: number, sha = a.repo.sha): string {
  const full = a.repo.path ? `${a.repo.path}/${path}` : path;
  return `https://github.com/${a.repo.owner}/${a.repo.repo}/blob/${sha}/${full.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
}

const verdictPill = (v: PatternMatch["verdict"]) => h(`span.pill.verdict-${v}`, v);
export const glyph = (pattern: string, size: "sm" | "lg" = "sm") => h(`span.glyph.glyph-${size}`, { "data-family": patternInfo(pattern)?.family ?? "" }, patternInfo(pattern)?.glyph ?? "?");

export function tile(iconName: IconName, value: string | number, label: string, tone = ""): HTMLElement {
  return h(`div.tile${tone ? "." + tone : ""}`, { "data-tip": label }, icon(iconName, 16), h("b", String(value)), h("span", label));
}

export function fileRow(a: Analysis, id: number, act: DrawerActions, extra?: Node): HTMLElement {
  const f = a.files[id];
  return h("button.row", { type: "button", onclick: () => act.select({ kind: "file", id }) }, h("span.dot", { style: { background: langHex(f.lang) } }), h("span.row-main", f.name, h("small", f.dir || "/")), extra ?? null);
}

export function section(title: string, count: number | string, body: () => Node[], open = false): HTMLElement {
  const d = h("details.section", open ? { open: true } : {}, h("summary", h("span.sum-title", title), h("span.count", String(count)), icon("chevron", 14, "chev")));
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    d.append(h("div.section-body", ...body()));
  };
  if (open) fill();
  d.addEventListener("toggle", fill);
  return d;
}

export function header(iconEl: Node, title: string, sub: string, actions: Node[] = []): HTMLElement {
  return h("header.panel-head", h("div.panel-icon", iconEl), h("div.panel-title", h("h2", title), sub ? h("p", sub) : null), h("div.panel-actions", ...actions));
}

// ---------------------------------------------------------------- File
export function fileInspector(a: Analysis, d: Derived, id: number, act: DrawerActions, diff: DiffResult | null = null): HTMLElement {
  const f = a.files[id];
  const issues = d.issuesByFile.get(id) ?? [];
  const patterns = d.patternsByFile.get(id) ?? [];
  const types = f.source?.types ?? [];
  const fns = f.source?.functions ?? [];
  const root = h("div.panel");
  root.append(
    header(h("span.lang-chip", { style: { background: langHex(f.lang) } }, LANG_LABEL[f.lang].slice(0, 2)), f.name, f.dir || "/", [
      h("a.icon-btn", { href: githubUrl(a, f.path, undefined, diff?.status[id] === "removed" ? diff.baseSha : a.repo.sha), target: "_blank", rel: "noopener", "aria-label": "Open on GitHub", "data-tip": "Open on GitHub" }, icon("github")),
    ]),
    h("div.tiles", tile("lines", fmt(f.loc), f.analyzed ? "lines" : "≈ lines"), tile("out", d.outgoing[id].length, "uses"), tile("in", d.incoming[id].length, "used by"), tile("cube", types.length + fns.length, "symbols")),
  );
  if (diff) {
    const status = diff.status[id];
    const delta = (status === "removed" ? 0 : f.loc) - diff.baseLoc[id];
    root.append(h(`div.diff-strip.st-${status}`, icon(status === "added" ? "plus" : status === "removed" ? "minus" : status === "modified" ? "diff" : "check", 15), h("b", status), status === "unchanged" ? null : h("span", `${delta >= 0 ? "+" : "−"}${Math.abs(delta)} lines since ${diff.baseRef}`)));
  }
  if (!f.analyzed) root.append(h("p.note", icon("info", 14), f.lang === "other" ? "Language not parsed: placed by size." : "Not analyzed (size or file cap)."));
  if (issues.length) {
    root.append(h("div.chips", ...issues.map((i) => h(`button.chip.sev-${i.severity}`, { type: "button", onclick: () => act.select({ kind: "issue", id: i.id }) }, icon(SEV_ICON[i.severity], 14), i.title))));
  }
  if (patterns.length) {
    root.append(h("div.chips", ...patterns.map((p) => h(`button.chip.verdict-${p.verdict}`, { type: "button", onclick: () => act.select({ kind: "pattern", id: p.id }) }, glyph(p.pattern), patternInfo(p.pattern)?.name ?? p.pattern))));
  }
  root.append(
    section("Uses", d.outgoing[id].length, () => d.outgoing[id].map((t) => fileRow(a, t, act, icon("out", 14, "muted")))),
    section("Used by", d.incoming[id].length, () => d.incoming[id].map((t) => fileRow(a, t, act, icon("in", 14, "muted")))),
  );
  if (types.length || fns.length) {
    root.append(section("Symbols", types.length + fns.length, () => [...types.map((t) => typeBlock(a, f, t)), ...(fns.length ? [h("div.members", ...fns.map((m) => memberRow(a, f, m)))] : [])]));
  }
  if (f.externals.length) root.append(section("External packages", f.externals.length, () => [h("div.chips", ...f.externals.map((x) => h("span.chip.ext", x)))]));
  if (f.unresolved.length) root.append(section("Unresolved imports", f.unresolved.length, () => [h("div.chips", ...f.unresolved.map((x) => h("span.chip.sev-warning", x)))]));
  return root;
}

const VIS: Record<string, string> = { public: "+", protected: "#", private: "−", internal: "~", package: "~" };

function memberRow(a: Analysis, f: FileNode, m: MethodInfo): HTMLElement {
  const sig = `${m.name}(${m.params.map((p) => p.name).join(", ")})${m.returns ? ": " + m.returns : ""}`;
  return h("a.member", { href: githubUrl(a, f.path, m.line), target: "_blank", rel: "noopener" }, h("span.vis", VIS[m.visibility]), h("code", sig), m.isStatic ? h("span.tag", "static") : null, m.isAbstract ? h("span.tag", "abstract") : null, h("span.loc", `${m.loc}`));
}

function typeBlock(a: Analysis, f: FileNode, t: TypeInfo): HTMLElement {
  const heritage = [...t.extends, ...t.implements];
  return h(
    "details.type",
    h("summary", icon("type", 14), h("b", t.name), h("span.tag", t.isAbstract && t.kind === "class" ? "abstract" : t.kind), heritage.length ? h("small", "→ " + heritage.join(", ")) : null, h("span.count", `${t.methods.length}·${t.fields.length}`)),
    h(
      "div.members",
      ...t.fields.map((x) => h("a.member", { href: githubUrl(a, f.path, x.line), target: "_blank", rel: "noopener" }, h("span.vis", VIS[x.visibility]), h("code", `${x.name}${x.type ? ": " + x.type : ""}`), x.isStatic ? h("span.tag", "static") : null)),
      ...t.methods.map((m) => memberRow(a, f, m)),
    ),
  );
}

// ---------------------------------------------------------------- Directory
export function dirInspector(a: Analysis, d: Derived, path: string, act: DrawerActions): HTMLElement {
  const dir = a.dirs.find((x) => x.path === path);
  const files = d.filesUnder.get(path) ?? [];
  const issues = new Map<string, Issue>();
  for (const f of files) for (const i of d.issuesByFile.get(f) ?? []) issues.set(i.id, i);
  for (const i of a.issues) if (i.dirs.includes(path)) issues.set(i.id, i);
  const patterns = new Set<string>();
  for (const f of files) for (const p of d.patternsByFile.get(f) ?? []) patterns.add(p.id);
  const langs = new Map<string, number>();
  for (const f of files) langs.set(a.files[f].lang, (langs.get(a.files[f].lang) ?? 0) + a.files[f].loc);
  const total = [...langs.values()].reduce((s, v) => s + v, 0) || 1;
  const sorted = [...langs.entries()].sort((x, y) => y[1] - x[1]);
  const root = h("div.panel");
  root.append(
    header(icon("folder", 22), dir?.name ?? (path || "/"), path || "repository root"),
    h("div.tiles", tile("file", fmt(files.length), "files"), tile("lines", fmt(dir?.loc ?? 0), "lines"), tile("warning", issues.size, "issues", issues.size ? "warn" : ""), tile("patterns", patterns.size, "patterns")),
    h("div.langbar", ...sorted.map(([l, v]) => h("span", { style: { flex: String(v / total), background: langHex(l as FileNode["lang"]) }, "data-tip": `${LANG_LABEL[l as FileNode["lang"]]} · ${Math.round((v / total) * 100)}%` }))),
  );
  if (issues.size) root.append(section("Issues inside", issues.size, () => [...issues.values()].slice(0, 80).map((i) => issueRow(a, i, act))));
  const children = dir?.children ?? [];
  if (children.length) {
    root.append(section("Folders", children.length, () => children.map((c) => {
      const cd = a.dirs.find((x) => x.path === c);
      return h("button.row", { type: "button", onclick: () => act.select({ kind: "dir", path: c }) }, icon("folder", 15, "muted"), h("span.row-main", cd?.name ?? c, h("small", `${cd?.fileCount ?? 0} files`)));
    })));
  }
  if (dir?.files.length) root.append(section("Files here", dir.files.length, () => [...dir.files].sort((x, y) => a.files[y].loc - a.files[x].loc).map((f) => fileRow(a, f, act, h("span.loc", fmt(a.files[f].loc))))));
  return root;
}

// ---------------------------------------------------------------- Issues
export function issueRow(a: Analysis, i: Issue, act: DrawerActions): HTMLElement {
  const where = i.files.length === 1 ? a.files[i.files[0]].name : i.dirs.length ? i.dirs[0] || "/" : `${i.files.length} files`;
  return h("button.row", { type: "button", onclick: () => act.select({ kind: "issue", id: i.id }) }, h(`span.sev-icon.sev-${i.severity}`, icon(SEV_ICON[i.severity], 15)), h("span.row-main", i.title, h("small", where)));
}

export function issuesPanel(a: Analysis, act: DrawerActions): HTMLElement {
  const bySev = (s: Severity) => a.issues.filter((i) => i.severity === s).length;
  const root = h("div.panel");
  root.append(
    header(icon("health", 22), "Health", `${a.issues.length} findings · ${RULES.length} fixed rules`),
    h("div.tiles", tile("error", bySev("error"), "errors", "err"), tile("warning", bySev("warning"), "warnings", "warn"), tile("info", bySev("info"), "info", "inf")),
  );
  if (!a.issues.length) root.append(h("div.empty", icon("check", 28), "No rule violation found."));
  for (const rule of RULES) {
    const list = a.issues.filter((i) => i.rule === rule.id);
    if (!list.length) continue;
    const worst = list.some((i) => i.severity === "error") ? "error" : list.some((i) => i.severity === "warning") ? "warning" : "info";
    const s = section(rule.title, list.length, () => [h("p.rule-what", rule.what), ...list.slice(0, 200).map((i) => issueRow(a, i, act))], list.length <= 3 && worst === "error");
    s.querySelector("summary")!.prepend(h(`span.sev-icon.sev-${worst}`, icon(SEV_ICON[worst], 15)));
    root.append(s);
  }
  return root;
}

export function issueDetail(a: Analysis, i: Issue, act: DrawerActions): HTMLElement {
  const rule = RULES.find((r) => r.id === i.rule);
  const root = h("div.panel");
  root.append(
    header(h(`span.sev-icon.big.sev-${i.severity}`, icon(SEV_ICON[i.severity], 22)), i.title, rule?.title ?? i.rule, [iconButton("health", "All findings", () => act.panel("issues"))]),
    h("p.lead", i.detail),
  );
  if (i.metric) {
    const ratio = Math.min(1, i.metric.limit / i.metric.value);
    root.append(h("div.meter", h("div.meter-bar", h("span.meter-limit", { style: { left: `${ratio * 100}%` } }), h(`span.meter-fill.sev-${i.severity}`, { style: { width: "100%" } })), h("small", `${i.metric.value} ${i.metric.unit} · limit ${i.metric.limit}`)));
  }
  if (i.files.length) root.append(section("Files", i.files.length, () => i.files.map((f) => fileRow(a, f, act)), i.files.length <= 12));
  if (i.dirs.length) root.append(section("Folders", i.dirs.length, () => i.dirs.map((p) => h("button.row", { type: "button", onclick: () => act.select({ kind: "dir", path: p }) }, icon("folder", 15, "muted"), h("span.row-main", p || "/")))));
  if (rule) root.append(section("Why it matters", "", () => [h("p", rule.what), h("p", rule.why)]));
  return root;
}

// ---------------------------------------------------------------- Patterns
export function patternsPanel(a: Analysis, act: DrawerActions): HTMLElement {
  const count = (v: PatternMatch["verdict"]) => a.patterns.filter((p) => p.verdict === v).length;
  const root = h("div.panel");
  root.append(
    header(icon("patterns", 22), "Design patterns", `${a.patterns.length} implementations detected`),
    h("div.tiles", tile("check", count("complete"), "complete", "ok"), tile("minus", count("partial"), "partial", "warn"), tile("ban", count("flawed"), "flawed", "err")),
  );
  if (!a.patterns.length) root.append(h("div.empty", icon("patterns", 28), "No design pattern recognised."));
  const grid = h("div.pattern-grid");
  for (const info of PATTERNS) {
    const list = a.patterns.filter((p) => p.pattern === info.id);
    if (!list.length) continue;
    const bar = h("div.verdict-bar", ...(["complete", "partial", "flawed"] as const).map((v) => h(`span.verdict-${v}`, { style: { flex: String(list.filter((p) => p.verdict === v).length) } })));
    const card = h("details.pattern-card", h("summary", glyph(info.id, "lg"), h("div", h("b", info.name), h("small", `${list.length} found`)), bar));
    card.addEventListener("toggle", () => {
      if (card.querySelector(".section-body")) return;
      card.append(h("div.section-body", ...list.map((p) => h("button.row", { type: "button", onclick: () => act.select({ kind: "pattern", id: p.id }) }, h(`span.vdot.verdict-${p.verdict}`), h("span.row-main", p.roles[0]?.types[0]?.name ?? "?", h("small", p.roles[0]?.role ?? "")), h("span.score", `${Math.round(p.score * 100)}%`)))));
    });
    grid.append(card);
  }
  root.append(grid);
  return root;
}

const CHECK_ICON = (c: PatternCheck): IconName => (c.ok ? "check" : c.kind === "anti" ? "ban" : "cross");

export function patternDetail(a: Analysis, m: PatternMatch, act: DrawerActions): HTMLElement {
  const info = patternInfo(m.pattern);
  const root = h("div.panel");
  const ring = h("div.score-ring", { style: { "--p": String(m.score) } as unknown as Partial<CSSStyleDeclaration>, "data-tip": "checks passed" }, h("b", `${Math.round(m.score * 100)}`), h("small", "%"));
  root.append(header(glyph(m.pattern, "lg"), info?.name ?? m.pattern, m.summary, [iconButton("patterns", "All patterns", () => act.panel("patterns"))]));
  root.append(h("div.verdict-row", verdictPill(m.verdict), ring, h("small.conf", `confidence ${Math.round(m.confidence * 100)}%`)));

  const roles = h("div.roles");
  for (const r of m.roles) {
    roles.append(h("div.role", h("span.role-name", r.role), h("div.chips", ...r.types.slice(0, 12).map((t) => h("button.chip", { type: "button", onclick: () => act.select({ kind: "file", id: t.file }) }, h("span.dot", { style: { background: langHex(a.files[t.file].lang) } }), t.name)), r.types.length > 12 ? h("span.chip", `+${r.types.length - 12}`) : null)));
  }
  root.append(roles);

  const groups: { title: string; tone: string; checks: PatternCheck[] }[] = [
    { title: "Shouldn't be there", tone: "anti", checks: m.checks.filter((c) => c.kind === "anti" && !c.ok) },
    { title: "Missing", tone: "missing", checks: m.checks.filter((c) => c.kind !== "anti" && !c.ok) },
    { title: "In place", tone: "ok", checks: m.checks.filter((c) => c.ok) },
  ];
  for (const g of groups) {
    if (!g.checks.length) continue;
    root.append(
      h(`div.check-group.${g.tone}`, h("h3", g.title),
        ...g.checks.map((c) => h("details.check", h("summary", h(`span.check-icon.${g.tone}`, icon(CHECK_ICON(c), 14)), h("span", c.label), c.kind === "required" ? null : h("span.tag", c.kind === "anti" ? "anti-pattern" : "good practice")), c.hint ? h("p", c.hint) : h("p.muted", c.kind === "required" ? "Core element of the pattern." : "")))),
    );
  }
  if (info) root.append(section("About this pattern", info.family, () => [h("p", info.intent)]));
  return root;
}

// ---------------------------------------------------------------- Shell
export class Drawer {
  readonly el = h("aside.drawer", { "aria-live": "polite" });
  private body = h("div.drawer-body");

  constructor(onClose: () => void) {
    this.el.append(h("div.drawer-grip"), iconButton("close", "Close (Esc)", onClose, "drawer-close"), this.body);
  }

  show(content: Node | null) {
    clear(this.body);
    if (content) {
      this.body.append(content);
      this.body.scrollTop = 0;
    }
    this.el.classList.toggle("open", !!content);
  }
}

export { LIMITS };
