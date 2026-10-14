import type { AnalysisContext } from "../analyze";
import { adjacency, shortestCycle, stronglyConnected } from "../graph";
import type { Issue, Severity } from "../model";

/** The fixed rule set. Thresholds are deliberately conventional and documented in the app. */
export const LIMITS = {
  godFileLoc: 600,
  godFileLocError: 1500,
  godClassMethods: 30,
  godClassFields: 20,
  fanOut: 20,
  hubFanIn: 25,
  hubFanOut: 10,
  longMethod: 100,
  longMethodError: 250,
  inheritanceDepth: 4,
  bigDirFiles: 40,
} as const;

export interface RuleInfo {
  id: string;
  title: string;
  severity: Severity;
  /** What the rule checks, in one sentence. */
  what: string;
  /** Why it matters / how to fix, one sentence. */
  why: string;
}

export const RULES: RuleInfo[] = [
  { id: "cycle", title: "Circular dependency", severity: "error", what: "Files that import each other, directly or through a chain.", why: "Cycles prevent isolated testing, reuse and clean builds; break them with an interface or by moving shared code down." },
  { id: "dir-cycle", title: "Package cycle", severity: "warning", what: "Directories whose files depend on each other in both directions.", why: "Modules should form layers; a two-way dependency means they are really one module or a boundary leaks." },
  { id: "layer", title: "Layer violation", severity: "error", what: "Inner layers (domain, core, utils) importing outer ones (infrastructure, UI, controllers).", why: "Dependencies must point inwards so business logic stays independent of frameworks and delivery." },
  { id: "god-file", title: "Oversized file", severity: "warning", what: `Files over ${LIMITS.godFileLoc} code lines.`, why: "Large files usually mix responsibilities; split by responsibility." },
  { id: "god-class", title: "God class", severity: "warning", what: `Classes with more than ${LIMITS.godClassMethods} methods or ${LIMITS.godClassFields} fields.`, why: "Too many responsibilities in one type (SRP); extract cohesive parts." },
  { id: "long-method", title: "Long method", severity: "warning", what: `Functions longer than ${LIMITS.longMethod} lines.`, why: "Long functions are hard to read and test; extract steps." },
  { id: "fan-out", title: "Too many dependencies", severity: "warning", what: `Files depending on more than ${LIMITS.fanOut} other files.`, why: "High efferent coupling makes a file fragile: any change around it can break it." },
  { id: "hub", title: "Dependency hub", severity: "warning", what: `Files used by more than ${LIMITS.hubFanIn} files while depending on more than ${LIMITS.hubFanOut}.`, why: "Changes ripple both ways through hubs; keep widely used code stable and dependency-free." },
  { id: "deep-inheritance", title: "Deep inheritance", severity: "warning", what: `Class hierarchies deeper than ${LIMITS.inheritanceDepth} levels.`, why: "Deep trees are rigid and hard to follow; prefer composition." },
  { id: "test-in-prod", title: "Test code in production", severity: "warning", what: "Production files importing test files, fixtures or mocks.", why: "Test helpers end up shipped and production depends on test-only code." },
  { id: "unresolved", title: "Broken import", severity: "warning", what: "Local imports that do not match any file of the repository.", why: "Dead path, missing file or an alias the map cannot follow." },
  { id: "orphan", title: "Unreferenced file", severity: "info", what: "Code files nothing imports and that import nothing local.", why: "Possibly dead code (or loaded by a framework/entry point)." },
  { id: "big-dir", title: "Crowded directory", severity: "info", what: `Directories holding more than ${LIMITS.bigDirFiles} files directly.`, why: "A flat directory hides structure; group files by feature." },
];

const LAYERS: { rank: number; names: string[] }[] = [
  { rank: 0, names: ["domain", "entities", "entity", "model", "models", "core", "utils", "util", "helpers", "shared", "common", "lib", "types"] },
  { rank: 1, names: ["application", "usecases", "use-cases", "usecase", "services", "service"] },
  { rank: 2, names: ["infrastructure", "infra", "adapters", "adapter", "persistence", "repositories", "repository", "db", "database", "data", "clients"] },
  { rank: 3, names: ["ui", "view", "views", "components", "pages", "screens", "controllers", "controller", "presentation", "web", "cli", "routes", "handlers", "api", "features"] },
];

function layerOf(path: string): { rank: number; name: string; at: string } | null {
  const parts = path.split("/").slice(0, -1);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase();
    const layer = LAYERS.find((l) => l.names.includes(p));
    if (layer) return { rank: layer.rank, name: p, at: parts.slice(0, i + 1).join("/") };
  }
  return null;
}

const ENTRY = /^(index|main|app|server|cli|__init__|__main__|setup|manage|conftest|program|startup|mod|lib|vite\.config|webpack\.config|.*\.config|.*\.d)\.[a-z]+$/i;

export function runRules(ctx: AnalysisContext): Issue[] {
  const { files, edges, dirs, adj, deg, types } = ctx;
  const issues: Issue[] = [];
  const name = (id: number) => files[id].name;

  // Circular dependencies (file level).
  for (const comp of stronglyConnected(adj)) {
    const within = new Set(comp);
    const cycle = shortestCycle(adj, comp[0], within);
    const compEdges: [number, number][] = [];
    for (const v of comp) for (const w of adj[v]) if (within.has(w)) compEdges.push([v, w]);
    issues.push({
      id: `cycle:${comp[0]}`, rule: "cycle", severity: comp.length >= 3 ? "error" : "warning",
      files: comp, dirs: [], edges: compEdges,
      title: `Circular dependency · ${comp.length} files`,
      detail: `${[...cycle, cycle[0]].map(name).join(" → ")}${comp.length > cycle.length ? ` (+${comp.length - cycle.length} more files in the same loop)` : ""}.`,
    });
  }

  // Package (directory) cycles: directories whose files depend on each other both ways.
  const dirIndex = new Map(dirs.map((d, i) => [d.path, i]));
  const dirOf = (fileId: number) => dirIndex.get(files[fileId].dir);
  const dirEdges: { from: number; to: number; kind: "import"; weight: number }[] = [];
  const dirEdgeFiles = new Map<string, [number, number][]>();
  for (const e of edges) {
    const a = dirOf(e.from);
    const b = dirOf(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${a}>${b}`;
    if (!dirEdgeFiles.has(key)) {
      dirEdgeFiles.set(key, []);
      dirEdges.push({ from: a, to: b, kind: "import", weight: 1 });
    }
    dirEdgeFiles.get(key)!.push([e.from, e.to]);
  }
  const dirAdj = adjacency(dirs.length, dirEdges);
  for (const comp of stronglyConnected(dirAdj)) {
    const within = new Set(comp);
    const cycle = shortestCycle(dirAdj, comp[0], within);
    const fileEdges: [number, number][] = [];
    for (const v of comp) for (const w of dirAdj[v]) if (within.has(w)) fileEdges.push(...(dirEdgeFiles.get(`${v}>${w}`) ?? []));
    issues.push({
      id: `dir-cycle:${dirs[comp[0]].path}`, rule: "dir-cycle", severity: "warning",
      files: [...new Set(fileEdges.flat())], dirs: comp.map((i) => dirs[i].path), edges: fileEdges,
      title: `Package cycle · ${comp.length} directories`,
      detail: `${[...cycle, cycle[0]].map((i) => dirs[i].path || "/").join(" ⇄ ")}.`,
    });
  }

  // Layer violations.
  const layerHits = new Map<string, [number, number][]>();
  for (const e of edges) {
    const a = layerOf(files[e.from].path);
    const b = layerOf(files[e.to].path);
    if (!a || !b || a.at === b.at || a.rank >= b.rank) continue;
    if (b.at.startsWith(a.at + "/")) continue; // a sub-folder of my own layer folder
    // Only flag a real inversion: inner (0) → outer (2,3), or application (1) → presentation (3).
    if (!((a.rank === 0 && b.rank >= 2) || (a.rank === 1 && b.rank === 3))) continue;
    const key = `${a.at}→${b.at}`;
    const list = layerHits.get(key) ?? [];
    list.push([e.from, e.to]);
    layerHits.set(key, list);
  }
  for (const [key, list] of layerHits) {
    const [from, to] = key.split("→");
    issues.push({
      id: `layer:${key}`, rule: "layer", severity: "error",
      files: [...new Set(list.flat())], dirs: [from, to], edges: list,
      title: `Layer violation · ${from.split("/").pop()} → ${to.split("/").pop()}`,
      detail: `${list.length} import${list.length > 1 ? "s" : ""} from "${from}" (inner layer) to "${to}" (outer layer), e.g. ${name(list[0][0])} → ${name(list[0][1])}.`,
    });
  }

  for (const f of files) {
    if (f.lang === "other" || !f.analyzed) continue;
    if (f.loc > LIMITS.godFileLoc) {
      issues.push({
        id: `god-file:${f.id}`, rule: "god-file", severity: f.loc > LIMITS.godFileLocError ? "error" : "warning",
        files: [f.id], dirs: [], edges: [], title: `Oversized file · ${f.loc} lines`,
        detail: `${f.name} has ${f.loc} code lines and ${f.source?.types.length ?? 0} types.`,
        metric: { value: f.loc, limit: LIMITS.godFileLoc, unit: "lines" },
      });
    }
    if (deg.fanOut[f.id] > LIMITS.fanOut) {
      issues.push({
        id: `fan-out:${f.id}`, rule: "fan-out", severity: "warning", files: [f.id], dirs: [],
        edges: edges.filter((e) => e.from === f.id).map((e) => [e.from, e.to]),
        title: `Too many dependencies · ${deg.fanOut[f.id]}`, detail: `${f.name} depends on ${deg.fanOut[f.id]} files.`,
        metric: { value: deg.fanOut[f.id], limit: LIMITS.fanOut, unit: "files" },
      });
    }
    if (deg.fanIn[f.id] > LIMITS.hubFanIn && deg.fanOut[f.id] > LIMITS.hubFanOut) {
      issues.push({
        id: `hub:${f.id}`, rule: "hub", severity: "warning", files: [f.id], dirs: [], edges: [],
        title: `Dependency hub · ${deg.fanIn[f.id]} in / ${deg.fanOut[f.id]} out`,
        detail: `${f.name} is used by ${deg.fanIn[f.id]} files and itself depends on ${deg.fanOut[f.id]}.`,
        metric: { value: deg.fanIn[f.id], limit: LIMITS.hubFanIn, unit: "dependents" },
      });
    }
    const longOnes = [...(f.source?.types.flatMap((t) => t.methods.map((m) => ({ m, owner: t.name }))) ?? []), ...(f.source?.functions.map((m) => ({ m, owner: "" })) ?? [])]
      .filter(({ m }) => m.loc > LIMITS.longMethod)
      .sort((a, b) => b.m.loc - a.m.loc);
    if (longOnes.length) {
      const worst = longOnes[0];
      issues.push({
        id: `long-method:${f.id}`, rule: "long-method", severity: worst.m.loc > LIMITS.longMethodError ? "error" : "warning",
        files: [f.id], dirs: [], edges: [],
        title: `Long method${longOnes.length > 1 ? `s · ${longOnes.length}` : ""} · ${worst.m.loc} lines`,
        detail: longOnes.slice(0, 5).map(({ m, owner }) => `${owner ? owner + "." : ""}${m.name} (${m.loc} lines, line ${m.line})`).join(", ") + ".",
        metric: { value: worst.m.loc, limit: LIMITS.longMethod, unit: "lines" },
      });
    }
    for (const t of f.source?.types ?? []) {
      const methods = t.methods.filter((m) => m.kind !== "ctor").length;
      if (methods > LIMITS.godClassMethods || t.fields.length > LIMITS.godClassFields) {
        issues.push({
          id: `god-class:${f.id}:${t.name}`, rule: "god-class", severity: "warning", files: [f.id], dirs: [], edges: [],
          title: `God class · ${t.name}`, detail: `${t.name} has ${methods} methods and ${t.fields.length} fields.`,
          metric: { value: Math.max(methods, t.fields.length), limit: methods > LIMITS.godClassMethods ? LIMITS.godClassMethods : LIMITS.godClassFields, unit: methods > LIMITS.godClassMethods ? "methods" : "fields" },
        });
      }
    }
    if (f.unresolved.length) {
      issues.push({
        id: `unresolved:${f.id}`, rule: "unresolved", severity: "warning", files: [f.id], dirs: [], edges: [],
        title: `Broken import${f.unresolved.length > 1 ? `s · ${f.unresolved.length}` : ""}`,
        detail: `${f.name} imports ${f.unresolved.slice(0, 4).map((s) => `"${s}"`).join(", ")}${f.unresolved.length > 4 ? "…" : ""}, not found in the repository.`,
      });
    }
    if (!f.isTest) {
      const testDeps = adj[f.id].filter((t) => files[t].isTest);
      if (testDeps.length) {
        issues.push({
          id: `test-in-prod:${f.id}`, rule: "test-in-prod", severity: "warning", files: [f.id, ...testDeps], dirs: [],
          edges: testDeps.map((t) => [f.id, t] as [number, number]), title: "Test code in production",
          detail: `${f.name} imports ${testDeps.map(name).slice(0, 3).join(", ")}.`,
        });
      }
    }
    if (!f.isTest && deg.fanIn[f.id] === 0 && deg.fanOut[f.id] === 0 && !ENTRY.test(f.name) && (f.source?.types.length || f.source?.functions.length)) {
      issues.push({
        id: `orphan:${f.id}`, rule: "orphan", severity: "info", files: [f.id], dirs: [], edges: [],
        title: "Unreferenced file", detail: `Nothing imports ${f.name} and it imports no local file.`,
      });
    }
  }

  for (const node of types.nodes) {
    if (node.info.kind !== "class") continue;
    const d = types.depth(node);
    if (d > LIMITS.inheritanceDepth) {
      const chain = [node];
      let cur = node;
      while (cur.parents.length && chain.length < 12) {
        cur = types.nodes[cur.parents[0]];
        chain.push(cur);
      }
      issues.push({
        id: `deep-inheritance:${node.file}:${node.info.name}`, rule: "deep-inheritance", severity: "warning",
        files: [...new Set(chain.map((c) => c.file))], dirs: [], edges: [],
        title: `Deep inheritance · ${d} levels`, detail: chain.map((c) => c.info.name).join(" → ") + ".",
        metric: { value: d, limit: LIMITS.inheritanceDepth, unit: "levels" },
      });
    }
  }

  for (const d of dirs) {
    if (d.files.length > LIMITS.bigDirFiles) {
      issues.push({
        id: `big-dir:${d.path}`, rule: "big-dir", severity: "info", files: [], dirs: [d.path], edges: [],
        title: `Crowded directory · ${d.files.length} files`, detail: `${d.path || "/"} holds ${d.files.length} files directly.`,
        metric: { value: d.files.length, limit: LIMITS.bigDirFiles, unit: "files" },
      });
    }
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || b.files.length - a.files.length);
}
