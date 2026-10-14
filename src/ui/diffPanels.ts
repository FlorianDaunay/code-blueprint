import type { DiffResult, PatternChange } from "../core/diff";
import type { Analysis } from "../core/model";
import { patternInfo } from "../core/patterns/catalog";
import { fmt, h, icon } from "./dom";
import { fileRow, glyph, header, issueRow, section, tile, type DrawerActions } from "./drawer";
import type { IconName } from "./icons";

export type RefList = { tags: string[]; branches: string[] } | "loading" | "error";

export interface CompareActions {
  compare(baseRef: string): void;
  exit(): void;
  changes(): void;
}

/** Pick the base ref to compare the current map with. */
export function comparePanel(a: Analysis, diff: DiffResult | null, refs: RefList, act: CompareActions): HTMLElement {
  const input = h("input.ref-input", { type: "text", placeholder: "tag, branch or commit sha", spellcheck: "false", autocomplete: "off", "aria-label": "Base ref" });
  const form = h(
    "form.ref-form",
    { onsubmit: (e: Event) => { e.preventDefault(); if (input.value.trim()) act.compare(input.value.trim()); } },
    icon("diff", 18, "muted"),
    input,
    h("button.go.small", { type: "submit", "aria-label": "Compare" }, icon("arrow", 18)),
  );
  const chip = (ref: string, kind: "tag" | "branch") => h("button.chip.ref-chip", { type: "button", onclick: () => act.compare(ref) }, icon(kind === "tag" ? "type" : "diff", 13, "muted"), ref);
  const root = h("div.panel", header(icon("diff", 22), "Compare", `current map: ${a.repo.ref}`));
  if (diff) {
    root.append(
      h("div.cmp-active",
        h("div.cmp-refs", h("code", diff.baseRef), icon("arrow", 16), h("code", diff.headRef)),
        h("div.row-actions", h("button.btn", { type: "button", onclick: act.changes }, icon("lines", 16), "Changes"), h("button.ghost", { type: "button", onclick: act.exit }, icon("close", 16), "Exit")),
      ),
    );
  }
  root.append(h("p.hint", "Show what changed since another version: added, removed and modified files, new or broken dependencies, findings and patterns."), form);
  if (refs === "loading") root.append(h("p.note", h("span.mini-spin"), "loading tags and branches…"));
  else if (refs === "error") root.append(h("p.note", icon("info", 14), "Tags and branches unavailable (API limit): type a ref."));
  else {
    const tags = refs.tags.filter((t) => t !== a.repo.ref).slice(0, 12);
    const branches = refs.branches.filter((b) => b !== a.repo.ref).slice(0, 10);
    if (tags.length) root.append(h("h3.sub", icon("type", 15), "Tags"), h("div.chips", ...tags.map((t) => chip(t, "tag"))));
    if (branches.length) root.append(h("h3.sub", icon("diff", 15), "Branches"), h("div.chips", ...branches.map((b) => chip(b, "branch"))));
  }
  queueMicrotask(() => input.focus());
  return root;
}

const CHANGE_ICON: Record<PatternChange["kind"], IconName> = { new: "plus", removed: "minus", improved: "up", regressed: "down" };

/** Everything that changed between base and head, at a glance, details on demand. */
export function changesPanel(a: Analysis, diff: DiffResult, act: DrawerActions & { compare(): void }): HTMLElement {
  const s = diff.stats;
  const root = h("div.panel");
  root.append(
    header(icon("diff", 22), "Changes", `${diff.baseRef} → ${diff.headRef}`, [h("button.icon-btn", { type: "button", "aria-label": "Change base", "data-tip": "Change base", onclick: act.compare }, icon("refresh"))]),
    h("div.tiles", tile("plus", s.added, "added", "ok"), tile("diff", s.modified, "modified", "warn"), tile("minus", s.removed, "removed", "err")),
    h("div.tiles", tile("lines", `+${fmt(s.locAdded)}`, "lines added", "ok"), tile("lines", `−${fmt(s.locRemoved)}`, "lines removed", "err"), tile("arcs", `+${s.depsAdded}/−${s.depsRemoved}`, "dependencies")),
  );
  const balance = diff.introducedIssues.length - diff.fixedIssues.length;
  root.append(h(`div.diff-verdict.${balance > 0 ? "worse" : balance < 0 ? "better" : "same"}`, icon(balance > 0 ? "down" : balance < 0 ? "up" : "minus", 18), balance > 0 ? `Health got worse: ${diff.introducedIssues.length} new finding(s), ${diff.fixedIssues.length} fixed` : balance < 0 ? `Health improved: ${diff.fixedIssues.length} finding(s) fixed, ${diff.introducedIssues.length} new` : `Health unchanged (${diff.introducedIssues.length} new, ${diff.fixedIssues.length} fixed)`));

  if (diff.introducedIssues.length) root.append(section("New findings", diff.introducedIssues.length, () => diff.introducedIssues.slice(0, 150).map((i) => issueRow(a, i, act)), diff.introducedIssues.length <= 6));
  if (diff.fixedIssues.length) root.append(section("Fixed findings", diff.fixedIssues.length, () => diff.fixedIssues.slice(0, 150).map((i) => issueRow(a, i, act))));
  if (diff.patternChanges.length) {
    root.append(section("Pattern changes", diff.patternChanges.length, () => diff.patternChanges.map((c) => h(
      "button.row", { type: "button", onclick: () => act.select({ kind: "pattern", id: c.match.id }) },
      h(`span.change-icon.ch-${c.kind}`, icon(CHANGE_ICON[c.kind], 14)),
      glyph(c.match.pattern),
      h("span.row-main", `${patternInfo(c.match.pattern)?.name ?? c.match.pattern} · ${c.match.roles[0]?.types[0]?.name ?? ""}`, h("small", c.from && c.to ? `${c.from} → ${c.to}` : c.kind === "new" ? `new · ${c.to}` : `removed · was ${c.from}`)),
    )), diff.patternChanges.length <= 6));
  }
  const changed = a.files
    .filter((f) => diff.status[f.id] !== "unchanged")
    .map((f) => ({ f, delta: (diff.status[f.id] === "removed" ? 0 : f.loc) - diff.baseLoc[f.id] }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  if (changed.length) {
    root.append(section("Changed files", changed.length, () => changed.slice(0, 300).map(({ f, delta }) => fileRow(a, f.id, act, h(`span.delta.st-${diff.status[f.id]}`, diff.status[f.id] === "added" ? "new" : diff.status[f.id] === "removed" ? "gone" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}`)))));
  }
  if (!changed.length) root.append(h("div.empty", icon("check", 28), "No code change between these refs."));
  return root;
}
