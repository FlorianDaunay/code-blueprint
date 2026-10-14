import "./styles.css";
import { themeStore } from "./themes";
import { Controller } from "./app/controller";
import { derive } from "./app/derived";
import { LENSES } from "./app/lenses";
import { loadPrefs, savePrefs, Store, type AppState, type Lens, type Panel, type Selection } from "./app/store";
import { layoutCity } from "./core/layout";
import { LANG_LABEL } from "./core/languages";
import { patternInfo } from "./core/patterns/catalog";
import { AnalyzeError, analyzeRepo, cancelAnalysis } from "./data/client";
import { fetchRefs, parseRepoInput } from "./data/github";
import { diffAnalyses } from "./core/diff";
import type { CityLayout } from "./core/layout";
import type { Analysis } from "./core/model";
import type { Derived } from "./app/derived";
import { changesPanel, comparePanel, type CompareActions, type RefList } from "./ui/diffPanels";
import { CityView } from "./scene/city";
import { langHex, scenePalette } from "./scene/palette";
import { clear, fmt, h } from "./ui/dom";
import { Drawer, dirInspector, fileInspector, issueDetail, issuesPanel, patternDetail, patternsPanel, type DrawerActions } from "./ui/drawer";
import { Labels } from "./ui/labels";
import { errorCard, helpPanel, Hud, landing, Loader, rememberRepo, Search, settingsPanel, Tooltip } from "./ui/shell";

const app = document.getElementById("app")!;
const stage = h("div.stage");
const overlay = h("div.overlay");
app.append(stage, overlay);

let palette = scenePalette(themeStore.active());
const city = new CityView(stage, palette);
const labels = new Labels(city);
stage.append(labels.root);
city.onFrame = () => labels.update();
// Slow GPU: turn the glow off (it can be turned back on in settings).
city.onLowPerformance = () => store.state.glow && store.set({ glow: false });

const store = new Store({ analysis: null, layout: null, derived: null, selection: null, hover: null, panel: "none", diff: null, ...loadPrefs() });
const controller = new Controller(store, city, labels, palette);

const select = (selection: Selection) => store.set({ selection, panel: selection ? "inspector" : store.state.panel === "inspector" ? "none" : store.state.panel, hover: null });
const setPanel = (panel: Panel) => store.set({ panel });
const drawerActions: DrawerActions = { select, panel: (p) => store.set({ panel: p }) };

const hud = new Hud({
  home: () => goHome(),
  lens: (lens) => store.set({ lens }),
  panel: setPanel,
  toggleArcs: () => store.set({ allArcs: !store.state.allArcs }),
  toggleIso: () => store.set({ iso: !store.state.iso }),
  resetView: () => {
    store.set({ selection: null, panel: store.state.panel === "inspector" ? "none" : store.state.panel });
    city.resetView();
  },
  search: () => search.open(),
  compare: () => store.set({ panel: store.state.diff ? (store.state.panel === "changes" ? "none" : "changes") : store.state.panel === "compare" ? "none" : "compare" }),
});
const drawer = new Drawer(() => back());
const tooltip = new Tooltip();
const search = new Search();
const loader = new Loader(() => {
  cancelAnalysis();
  loader.hide();
  if (!store.state.analysis) showLanding();
});
const landingSlot = h("div.landing-slot");
const errorSlot = h("div.error-slot");
overlay.append(hud.top, hud.lensBar, hud.legend, drawer.el, tooltip.el, landingSlot, loader.el, errorSlot, search.el);

// ---------------------------------------------------------------- Rendering of the overlay
store.subscribe((s, prev) => {
  if (s.analysis !== prev.analysis || s.panel !== prev.panel || s.lens !== prev.lens || s.allArcs !== prev.allArcs || s.iso !== prev.iso || s.diff !== prev.diff) hud.render(s);
  if (s.analysis !== prev.analysis || s.lens !== prev.lens || s.diff !== prev.diff) {
    if (controller.paint) hud.setLegend(controller.paint.legend, s.lens);
  }
  if (s.selection !== prev.selection || s.panel !== prev.panel || s.analysis !== prev.analysis || s.diff !== prev.diff) renderDrawer(s);
  if (s.lens !== prev.lens || s.allArcs !== prev.allArcs || s.iso !== prev.iso || s.glow !== prev.glow) savePrefs(s);
  app.classList.toggle("has-map", !!s.analysis);
  app.classList.toggle("drawer-open", s.panel !== "none");
  if (s.panel !== prev.panel) city.setInsetRight(s.panel !== "none" && window.innerWidth > 760 ? drawer.el.offsetWidth + 16 : 0);
});

function renderDrawer(s: AppState) {
  const a = s.analysis;
  const d = s.derived;
  if (s.panel === "settings") return drawer.show(settingsPanel(s, {
    toggleGlow: () => store.set({ glow: !store.state.glow }),
    toggleIso: () => store.set({ iso: !store.state.iso }),
    toggleArcs: () => store.set({ allArcs: !store.state.allArcs }),
    reanalyze: () => a && load(routeOf(a.repo), true),
  }));
  if (s.panel === "help") return drawer.show(helpPanel());
  if (!a || !d) return drawer.show(null);
  if (s.panel === "compare") {
    loadRefs();
    return drawer.show(comparePanel(a, s.diff, refsFor(a), compareActions));
  }
  if (s.panel === "changes" && s.diff) return drawer.show(changesPanel(a, s.diff, { ...drawerActions, compare: () => store.set({ panel: "compare" }) }));
  if (s.panel === "issues") return drawer.show(issuesPanel(a, drawerActions));
  if (s.panel === "patterns") return drawer.show(patternsPanel(a, drawerActions));
  const sel = s.selection;
  if (s.panel !== "inspector" || !sel) return drawer.show(null);
  if (sel.kind === "file") return drawer.show(fileInspector(a, d, sel.id, drawerActions, s.diff));
  if (sel.kind === "dir") return drawer.show(dirInspector(a, d, sel.path, drawerActions));
  if (sel.kind === "issue") {
    const issue = d.issueById.get(sel.id);
    return drawer.show(issue ? issueDetail(a, issue, drawerActions) : null);
  }
  const m = d.patternById.get(sel.id);
  return drawer.show(m ? patternDetail(a, m, drawerActions) : null);
}

// ---------------------------------------------------------------- Theme
themeStore.subscribe((theme) => {
  palette = scenePalette(theme);
  controller.setPalette(palette);
  if (controller.paint) hud.setLegend(controller.paint.legend, store.state.lens);
});

// ---------------------------------------------------------------- City interactions
city.onHover = (pick, x, y) => {
  const a = store.state.analysis;
  if (!a || !pick) {
    tooltip.hide();
    if (store.state.hover !== null) store.set({ hover: null });
    return;
  }
  if (pick.kind === "file") {
    const f = a.files[pick.id];
    const d = store.state.derived!;
    const issues = d.issuesByFile.get(f.id)?.length ?? 0;
    const pats = d.patternsByFile.get(f.id) ?? [];
    tooltip.show(x, y, [
      h("div.tt-title", h("span.dot", { style: { background: langHex(f.lang) } }), f.name),
      h("div.tt-stats", h("span", `${fmt(f.loc)} lines`), h("span", `↗ ${d.outgoing[f.id].length}`), h("span", `↙ ${d.incoming[f.id].length}`), issues ? h("span.tt-warn", `⚠ ${issues}`) : null),
      pats.length ? h("div.tt-pats", ...pats.slice(0, 3).map((p) => h(`span.verdict-${p.verdict}`, patternInfo(p.pattern)?.name ?? p.pattern))) : null,
    ]);
    if (!store.state.selection && store.state.hover !== pick.id) store.set({ hover: pick.id });
  } else {
    const dir = a.dirs.find((d) => d.path === pick.path);
    tooltip.show(x, y, [h("div.tt-title", "▱ ", dir?.name ?? pick.path), h("div.tt-stats", h("span", `${dir?.fileCount ?? 0} files`), h("span", `${fmt(dir?.loc ?? 0)} lines`))]);
    if (store.state.hover !== null) store.set({ hover: null });
  }
};

city.onClick = (pick) => {
  if (!store.state.analysis) return;
  if (!pick) return select(null);
  if (pick.kind === "file") select({ kind: "file", id: pick.id });
  else if (pick.path === "") select(null);
  else select({ kind: "dir", path: pick.path });
};

function back() {
  const s = store.state;
  if (s.selection) select(null);
  else if (s.panel !== "none") store.set({ panel: "none" });
}

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
  if (e.key === "Escape") return back();
  if (!store.state.analysis) return;
  if (e.key === "/" || (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    return search.open();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const lens = LENSES.find((l) => l.key === e.key && (!l.diffOnly || store.state.diff));
  if (lens) return store.set({ lens: lens.id as Lens });
  if (e.key.toLowerCase() === "c") return store.set({ panel: store.state.diff ? "changes" : "compare" });
  switch (e.key.toLowerCase()) {
    case "a":
      return store.set({ allArcs: !store.state.allArcs });
    case "i":
      return store.set({ iso: !store.state.iso });
    case "r":
      store.set({ selection: null });
      return city.resetView();
    case "?":
      return store.set({ panel: store.state.panel === "help" ? "none" : "help" });
  }
});

// ---------------------------------------------------------------- Loading & routing
const routeOf = (r: { owner: string; repo: string; ref?: string; path?: string }) => `${r.owner}/${r.repo}${r.path || (r.ref && r.ref !== "main" && r.ref !== "master") ? `/tree/${encodeURIComponent(r.ref ?? "")}${r.path ? "/" + r.path : ""}` : ""}`;

function showLanding() {
  clear(landingSlot);
  clear(errorSlot);
  landingSlot.append(landing((input) => navigate(input)));
  app.classList.add("on-landing");
  city.controls.autoRotate = true;
  city.controls.autoRotateSpeed = 0.35;
}

function goHome() {
  loadedRoute = "";
  head = null;
  cancelAnalysis();
  loader.hide();
  history.pushState(null, "", location.pathname + location.search);
  store.set({ analysis: null, layout: null, derived: null, diff: null, selection: null, panel: "none", hover: null });
  city.load(layoutCity([], [{ path: "", name: "/", parent: null, depth: 0, children: [], files: [], loc: 0, fileCount: 0 }]));
  document.title = "code·blueprint";
  showLanding();
}

function navigate(input: string) {
  const parsed = parseRepoInput(input);
  if (!parsed) {
    clear(errorSlot);
    errorSlot.append(errorCard("That doesn't look like a repository", "Use owner/repo or paste a github.com URL.", () => clear(errorSlot), () => { clear(errorSlot); }));
    return;
  }
  const route = routeOf(parsed);
  if (location.hash.slice(2) !== route) history.pushState(null, "", `#/${route}`);
  load(route);
}

// ---------------------------------------------------------------- Compare two refs (diff city)
/** The map as loaded (head), restored when leaving a comparison. */
let head: { analysis: Analysis; layout: CityLayout; derived: Derived } | null = null;
const refsCache = new Map<string, RefList>();

function refsFor(a: Analysis): RefList {
  return refsCache.get(`${a.repo.owner}/${a.repo.repo}`) ?? "loading";
}

function loadRefs() {
  const a = head?.analysis;
  if (!a) return;
  const key = `${a.repo.owner}/${a.repo.repo}`;
  if (refsCache.has(key)) return;
  refsCache.set(key, "loading");
  fetchRefs(a.repo.owner, a.repo.repo)
    .then((refs) => refsCache.set(key, refs))
    .catch(() => refsCache.set(key, "error"))
    .finally(() => store.state.panel === "compare" && renderDrawer(store.state));
}

const compareActions: CompareActions = {
  compare: (ref) => void startCompare(ref),
  exit: () => exitCompare(),
  changes: () => store.set({ panel: "changes" }),
};

async function startCompare(baseRef: string): Promise<boolean> {
  const h0 = head;
  if (!h0) return false;
  const r = h0.analysis.repo;
  if (baseRef === r.ref || baseRef === r.sha) return false;
  const token = ++loadToken;
  clear(errorSlot);
  loader.start(`${baseRef} → ${r.ref}`);
  try {
    const { analysis: base } = await analyzeRepo(`${r.owner}/${r.repo}/tree/${encodeURIComponent(baseRef)}${r.path ? "/" + r.path : ""}`, { onProgress: (p) => token === loadToken && loader.update(p) });
    if (token !== loadToken) return false;
    const { combined, diff } = diffAnalyses(base, h0.analysis);
    diff.baseRef = baseRef;
    const layout = layoutCity(combined.files, combined.dirs);
    const derived = derive(combined);
    // Fixed findings and removed patterns are not part of the head analysis, but can be inspected.
    for (const i of diff.fixedIssues) derived.issueById.set(i.id, i);
    for (const c of diff.patternChanges) if (c.kind === "removed") derived.patternById.set(c.match.id, c.match);
    search.setAnalysis(combined, searchSelect);
    store.set({ analysis: combined, layout, derived, diff, lens: "diff", selection: null, hover: null, panel: "changes" });
    loader.hide();
    return true;
  } catch (error) {
    if (token !== loadToken) return false;
    loader.hide();
    const e = error instanceof AnalyzeError ? error : new AnalyzeError("network", String(error));
    errorSlot.append(errorCard(e.code === "not-found" ? `"${baseRef}" not found` : "Comparison failed", e.code === "not-found" ? "Use an existing tag, branch or commit sha." : e.message, () => void startCompare(baseRef), () => clear(errorSlot)));
    return false;
  }
}

function exitCompare() {
  if (!head || !store.state.diff) return;
  search.setAnalysis(head.analysis, searchSelect);
  store.set({ ...head, diff: null, lens: store.state.lens === "diff" ? "structure" : store.state.lens, selection: null, hover: null, panel: "none" });
}

const searchSelect = (kind: "file" | "dir", key: string | number) => select(kind === "file" ? { kind: "file", id: key as number } : { kind: "dir", path: key as string });

// ---------------------------------------------------------------- Deep links: #/owner/repo?f=<file>&l=<lens>
let loadedRoute = "";

function selectionQuery(st: AppState): string {
  const a = st.analysis;
  const q = new URLSearchParams();
  const sel = st.selection;
  if (a && sel?.kind === "file") q.set("f", a.files[sel.id].path);
  else if (sel?.kind === "dir") q.set("d", sel.path);
  else if (sel?.kind === "issue") q.set("i", sel.id);
  else if (sel?.kind === "pattern") q.set("p", sel.id);
  if (st.diff) q.set("cmp", st.diff.baseRef);
  if (st.lens !== "structure") q.set("l", st.lens);
  const text = q.toString();
  return text ? "?" + text : "";
}

async function applyQuery(query: string) {
  const q = new URLSearchParams(query);
  // Comparison first: it replaces the map the rest of the query refers to.
  const cmp = q.get("cmp");
  if (cmp && store.state.diff?.baseRef !== cmp) {
    if (!(await startCompare(cmp))) return;
  } else if (!cmp && store.state.diff) exitCompare();
  const s = store.state;
  const a = s.analysis;
  const d = s.derived;
  if (!a || !d) return;
  const lens = LENSES.find((l) => l.id === q.get("l"))?.id ?? s.lens;
  let selection: Selection = null;
  const f = q.get("f");
  const dir = q.get("d");
  const i = q.get("i");
  const p = q.get("p");
  if (f) {
    const file = a.files.find((x) => x.path === f);
    if (file) selection = { kind: "file", id: file.id };
  } else if (dir !== null && d.dirSet.has(dir)) selection = { kind: "dir", path: dir };
  else if (i && d.issueById.has(i)) selection = { kind: "issue", id: i };
  else if (p && d.patternById.has(p)) selection = { kind: "pattern", id: p };
  store.set({ lens, selection, panel: selection ? "inspector" : s.panel });
}

store.subscribe((s, prev) => {
  if (!s.analysis || !loadedRoute) return;
  if (s.selection === prev.selection && s.lens === prev.lens && s.analysis === prev.analysis && s.diff === prev.diff) return;
  const hash = `#/${loadedRoute}${selectionQuery(s)}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
});

let loadToken = 0;
async function load(input: string, force = false, query = "") {
  const token = ++loadToken;
  clear(errorSlot);
  clear(landingSlot);
  app.classList.remove("on-landing");
  loader.start(input);
  try {
    const { analysis } = await analyzeRepo(input, { onProgress: (p) => token === loadToken && loader.update(p) }, force);
    if (token !== loadToken) return;
    rememberRepo(routeOf(analysis.repo));
    const layout = layoutCity(analysis.files, analysis.dirs);
    const derived = derive(analysis);
    city.controls.autoRotate = false;
    search.setAnalysis(analysis, searchSelect);
    head = { analysis, layout, derived };
    loadedRoute = input;
    store.set({ analysis, layout, derived, diff: null, lens: store.state.lens === "diff" ? "structure" : store.state.lens, selection: null, hover: null, panel: "none" });
    loader.hide();
    if (query) setTimeout(() => void applyQuery(query), 300);
    document.title = `${analysis.repo.owner}/${analysis.repo.repo} · code·blueprint`;
  } catch (error) {
    if (token !== loadToken) return;
    loader.hide();
    const e = error instanceof AnalyzeError ? error : new AnalyzeError("network", String(error));
    const detail =
      e.code === "rate-limit" && e.resetAt ? `${e.message} It resets at ${new Date(e.resetAt).toLocaleTimeString()}.`
      : e.code === "not-found" ? "Check the name. Only public repositories can be mapped."
      : e.message;
    const title = e.code === "rate-limit" ? "GitHub needs a break" : e.code === "not-found" ? "Repository not found" : e.code === "empty" ? "Nothing to map" : "Something went wrong";
    errorSlot.append(errorCard(title, detail, () => load(input, force), goHome));
  }
}

function fromHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const route = decodeURIComponent(path);
  if (route && route === loadedRoute && store.state.analysis) void applyQuery(query);
  else if (route && parseRepoInput(route)) load(route, false, query);
  else goHome();
}

window.addEventListener("popstate", fromHash);
fromHash();

// Debug/automation handle (used by tests and the console).
(window as unknown as { codeBlueprint: unknown }).codeBlueprint = { store, city, themeStore, LANG_LABEL };
