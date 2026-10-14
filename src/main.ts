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
import { parseRepoInput } from "./data/github";
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

const store = new Store({ analysis: null, layout: null, derived: null, selection: null, hover: null, panel: "none", ...loadPrefs() });
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
  if (s.analysis !== prev.analysis || s.panel !== prev.panel || s.lens !== prev.lens || s.allArcs !== prev.allArcs || s.iso !== prev.iso) hud.render(s);
  if (s.analysis !== prev.analysis || s.lens !== prev.lens) {
    if (controller.paint) hud.setLegend(controller.paint.legend, s.lens);
  }
  if (s.selection !== prev.selection || s.panel !== prev.panel || s.analysis !== prev.analysis) renderDrawer(s);
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
  if (s.panel === "issues") return drawer.show(issuesPanel(a, drawerActions));
  if (s.panel === "patterns") return drawer.show(patternsPanel(a, drawerActions));
  const sel = s.selection;
  if (s.panel !== "inspector" || !sel) return drawer.show(null);
  if (sel.kind === "file") return drawer.show(fileInspector(a, d, sel.id, drawerActions));
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
  const lens = LENSES.find((l) => l.key === e.key);
  if (lens) return store.set({ lens: lens.id as Lens });
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
const routeOf = (r: { owner: string; repo: string; ref?: string; path?: string }) => `${r.owner}/${r.repo}${r.path || (r.ref && r.ref !== "main" && r.ref !== "master") ? `/tree/${r.ref}${r.path ? "/" + r.path : ""}` : ""}`;

function showLanding() {
  clear(landingSlot);
  clear(errorSlot);
  landingSlot.append(landing((input) => navigate(input)));
  app.classList.add("on-landing");
  city.controls.autoRotate = true;
  city.controls.autoRotateSpeed = 0.35;
}

function goHome() {
  cancelAnalysis();
  loader.hide();
  history.pushState(null, "", location.pathname + location.search);
  store.set({ analysis: null, layout: null, derived: null, selection: null, panel: "none", hover: null });
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

let loadToken = 0;
async function load(input: string, force = false) {
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
    search.setAnalysis(analysis, (kind, key) => select(kind === "file" ? { kind: "file", id: key as number } : { kind: "dir", path: key as string }));
    store.set({ analysis, layout, derived, selection: null, hover: null, panel: "none" });
    loader.hide();
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
  const route = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (route && parseRepoInput(route)) load(route);
  else goHome();
}

window.addEventListener("popstate", fromHash);
fromHash();

// Debug/automation handle (used by tests and the console).
(window as unknown as { codeBlueprint: unknown }).codeBlueprint = { store, city, LANG_LABEL };
