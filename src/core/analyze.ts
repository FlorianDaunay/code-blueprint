import { extract } from "./extract";
import { adjacency, buildDirs, compactDirs, degrees, type Degree } from "./graph";
import { estimateLoc, extOf, isTestPath, langOf } from "./languages";
import { ANALYSIS_VERSION, PARSED_LANGS, type Analysis, type DirNode, type Edge, type FileNode, type RepoRef } from "./model";
import { detectPatterns } from "./patterns";
import { readConfigs, resolveImports } from "./resolve";
import { runRules } from "./rules";
import { buildTypeModel, type TypeModel } from "./types";

export interface AnalysisInput {
  repo: RepoRef;
  /** Every code file of the tree (already filtered), with byte sizes. */
  entries: { path: string; size: number }[];
  /** Contents of the files that were fetched. */
  contents: Map<string, string>;
  configs: { path: string; text: string }[];
  skipped: { reason: string; count: number }[];
  treeTruncated: boolean;
  startedAt: number;
}

/** Everything rules and pattern detectors can look at. */
export interface AnalysisContext {
  files: FileNode[];
  edges: Edge[];
  dirs: DirNode[];
  types: TypeModel;
  adj: number[][];
  deg: Degree;
}

export function analyze(input: AnalysisInput): Analysis {
  const files: FileNode[] = [];
  for (const { path, size } of input.entries) {
    const lang = langOf(path);
    if (!lang) continue;
    const slash = path.lastIndexOf("/");
    const file: FileNode = {
      id: files.length, path, name: path.slice(slash + 1), dir: slash < 0 ? "" : path.slice(0, slash), ext: extOf(path), lang, size,
      loc: estimateLoc(size), analyzed: false, isTest: isTestPath(path), unresolved: [], externals: [],
    };
    const text = input.contents.get(path);
    if (text !== undefined && PARSED_LANGS.includes(lang)) {
      try {
        file.source = extract(text, path, lang);
        file.loc = file.source.loc;
        file.analyzed = true;
      } catch (error) {
        console.warn(`code-blueprint: could not parse ${path}`, error);
      }
    }
    files.push(file);
  }

  const cfg = readConfigs(input.configs);
  const { edges: importEdges } = resolveImports(files, cfg);
  const { model, inheritEdges } = buildTypeModel(files, importEdges);
  const edges = [...importEdges, ...inheritEdges];
  const dirs = compactDirs(buildDirs(files));
  const adj = adjacency(files.length, edges);
  const deg = degrees(files.length, edges);
  const ctx: AnalysisContext = { files, edges, dirs, types: model, adj, deg };

  const issues = runRules(ctx);
  const patterns = detectPatterns(ctx);

  // Lighten the payload: method bodies and reference lists were only needed for detection.
  for (const f of files) {
    if (!f.source) continue;
    f.source.refs = [];
    f.source.selectors = [];
    for (const t of f.source.types) for (const m of t.methods) m.body = "";
    for (const fn of f.source.functions) fn.body = "";
    for (const v of f.source.variables) v.init = v.init?.slice(0, 80);
  }

  const langs: Record<string, number> = {};
  for (const f of files) langs[f.lang === "other" ? f.ext : f.lang] = (langs[f.lang === "other" ? f.ext : f.lang] ?? 0) + 1;
  const extCount = new Map<string, number>();
  for (const f of files) for (const x of f.externals) extCount.set(x, (extCount.get(x) ?? 0) + 1);

  return {
    version: ANALYSIS_VERSION,
    repo: input.repo,
    createdAt: Date.now(),
    files,
    dirs,
    edges,
    issues,
    patterns,
    stats: {
      files: files.length,
      analyzedFiles: files.filter((f) => f.analyzed).length,
      loc: files.reduce((s, f) => s + f.loc, 0),
      dirs: dirs.length,
      edges: edges.length,
      langs,
      externals: [...extCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
      skipped: input.skipped,
      treeTruncated: input.treeTruncated,
      durationMs: Date.now() - input.startedAt,
    },
  };
}
