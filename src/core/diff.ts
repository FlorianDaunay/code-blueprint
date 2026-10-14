import { buildDirs, compactDirs } from "./graph";
import type { Analysis, FileNode, Issue, PatternMatch, PatternVerdict } from "./model";

/**
 * Compares two analyses of the same repository (base = older ref, head = current) and builds one
 * combined analysis to draw a single "diff city": head files keep their ids, files that only exist
 * in base are appended so they can be shown as ghosts where they used to be.
 */

export type FileStatus = "added" | "removed" | "modified" | "unchanged";

export interface PatternChange {
  kind: "new" | "removed" | "improved" | "regressed";
  match: PatternMatch;
  from?: PatternVerdict;
  to?: PatternVerdict;
}

export interface DiffResult {
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  /** Indexed by combined file id. */
  status: FileStatus[];
  /** Code lines in base (0 when added), indexed by combined file id. */
  baseLoc: number[];
  addedEdges: [number, number][];
  removedEdges: [number, number][];
  introducedIssues: Issue[];
  fixedIssues: Issue[];
  patternChanges: PatternChange[];
  stats: { added: number; removed: number; modified: number; unchanged: number; locAdded: number; locRemoved: number; depsAdded: number; depsRemoved: number };
}

const VERDICT_RANK: Record<PatternVerdict, number> = { complete: 2, partial: 1, flawed: 0 };

export function diffAnalyses(base: Analysis, head: Analysis): { combined: Analysis; diff: DiffResult } {
  const headByPath = new Map(head.files.map((f) => [f.path, f]));
  const baseByPath = new Map(base.files.map((f) => [f.path, f]));

  // Combined file list: head files (same ids) + base-only files appended.
  const files: FileNode[] = [...head.files];
  const baseToCombined = new Map<number, number>();
  for (const bf of base.files) {
    const hf = headByPath.get(bf.path);
    if (hf) baseToCombined.set(bf.id, hf.id);
    else {
      const id = files.length;
      files.push({ ...bf, id, source: bf.source, externals: [...bf.externals], unresolved: [...bf.unresolved] });
      baseToCombined.set(bf.id, id);
    }
  }

  const status: FileStatus[] = new Array(files.length);
  const baseLoc: number[] = new Array(files.length).fill(0);
  let locAdded = 0;
  let locRemoved = 0;
  for (const f of files) {
    const bf = baseByPath.get(f.path);
    const inHead = f.id < head.files.length;
    if (!bf) status[f.id] = "added";
    else if (!inHead) status[f.id] = "removed";
    else if (bf.blob && f.blob ? bf.blob !== f.blob : bf.size !== f.size) status[f.id] = "modified";
    else status[f.id] = "unchanged";
    baseLoc[f.id] = bf?.loc ?? 0;
    const delta = (inHead ? f.loc : 0) - (bf?.loc ?? 0);
    if (status[f.id] === "added") locAdded += f.loc;
    else if (status[f.id] === "removed") locRemoved += bf!.loc;
    else if (delta > 0) locAdded += delta;
    else locRemoved -= delta;
  }

  // Dependencies, keyed by file paths.
  const edgeKey = (a: string, b: string) => `${a}\u0000${b}`;
  const headEdges = new Set(head.edges.map((e) => edgeKey(head.files[e.from].path, head.files[e.to].path)));
  const baseEdges = new Set(base.edges.map((e) => edgeKey(base.files[e.from].path, base.files[e.to].path)));
  const addedEdges: [number, number][] = [];
  const removedEdges: [number, number][] = [];
  const seen = new Set<string>();
  for (const e of head.edges) {
    const k = edgeKey(head.files[e.from].path, head.files[e.to].path);
    if (!baseEdges.has(k) && !seen.has(k)) {
      seen.add(k);
      addedEdges.push([e.from, e.to]);
    }
  }
  for (const e of base.edges) {
    const k = edgeKey(base.files[e.from].path, base.files[e.to].path);
    if (!headEdges.has(k) && !seen.has(k)) {
      seen.add(k);
      removedEdges.push([baseToCombined.get(e.from)!, baseToCombined.get(e.to)!]);
    }
  }

  // Issues: identity = rule + involved paths (independent of file ids).
  const issueKey = (i: Issue, a: Analysis) => `${i.rule}|${i.files.map((f) => a.files[f].path).sort().join(",")}|${[...i.dirs].sort().join(",")}`;
  const baseIssueKeys = new Set(base.issues.map((i) => issueKey(i, base)));
  const headIssueKeys = new Set(head.issues.map((i) => issueKey(i, head)));
  const remapIssue = (i: Issue): Issue => ({
    ...i,
    id: `fixed:${i.id}`,
    files: i.files.map((f) => baseToCombined.get(f)!),
    edges: i.edges.map(([a, b]) => [baseToCombined.get(a)!, baseToCombined.get(b)!] as [number, number]),
  });
  const introducedIssues = head.issues.filter((i) => !baseIssueKeys.has(issueKey(i, head)));
  const fixedIssues = base.issues.filter((i) => !headIssueKeys.has(issueKey(i, base))).map(remapIssue);

  // Patterns: identity = pattern + main participant (name + file path).
  const patternKey = (m: PatternMatch, a: Analysis) => {
    const t = m.roles[0]?.types[0];
    return t ? `${m.pattern}|${t.name}|${a.files[t.file].path}` : m.id;
  };
  const basePatterns = new Map(base.patterns.map((m) => [patternKey(m, base), m]));
  const headPatterns = new Map(head.patterns.map((m) => [patternKey(m, head), m]));
  const patternChanges: PatternChange[] = [];
  for (const [k, m] of headPatterns) {
    const old = basePatterns.get(k);
    if (!old) patternChanges.push({ kind: "new", match: m, to: m.verdict });
    else if (VERDICT_RANK[m.verdict] !== VERDICT_RANK[old.verdict]) {
      patternChanges.push({ kind: VERDICT_RANK[m.verdict] > VERDICT_RANK[old.verdict] ? "improved" : "regressed", match: m, from: old.verdict, to: m.verdict });
    }
  }
  for (const [k, m] of basePatterns) {
    if (headPatterns.has(k)) continue;
    const remapped: PatternMatch = {
      ...m,
      id: `removed:${m.id}`,
      files: m.files.map((f) => baseToCombined.get(f)!),
      roles: m.roles.map((r) => ({ ...r, types: r.types.map((t) => ({ ...t, file: baseToCombined.get(t.file)! })) })),
    };
    patternChanges.push({ kind: "removed", match: remapped, from: m.verdict });
  }

  const count = (s: FileStatus) => status.filter((x) => x === s).length;
  const diff: DiffResult = {
    baseRef: base.repo.ref,
    baseSha: base.repo.sha,
    headRef: head.repo.ref,
    headSha: head.repo.sha,
    status,
    baseLoc,
    addedEdges,
    removedEdges,
    introducedIssues,
    fixedIssues,
    patternChanges,
    stats: { added: count("added"), removed: count("removed"), modified: count("modified"), unchanged: count("unchanged"), locAdded, locRemoved, depsAdded: addedEdges.length, depsRemoved: removedEdges.length },
  };
  const combined: Analysis = { ...head, files, dirs: compactDirs(buildDirs(files)) };
  return { combined, diff };
}
