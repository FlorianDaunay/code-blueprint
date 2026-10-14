import type { Analysis, Issue, PatternMatch, PatternVerdict, Severity } from "../core/model";

/** Indexes computed once per analysis for fast lookups in the UI. */
export interface Derived {
  issuesByFile: Map<number, Issue[]>;
  worstSeverity: (Severity | undefined)[];
  patternsByFile: Map<number, PatternMatch[]>;
  worstVerdict: (PatternVerdict | undefined)[];
  outgoing: number[][];
  incoming: number[][];
  maxDegree: number;
  issueById: Map<string, Issue>;
  patternById: Map<string, PatternMatch>;
  /** Files below each directory (recursive). */
  filesUnder: Map<string, number[]>;
  /** Directory ancestors of a file's directory, nearest first, as present in `dirs`. */
  dirSet: Set<string>;
}

const SEV: Record<Severity, number> = { error: 3, warning: 2, info: 1 };
const VERDICT: Record<PatternVerdict, number> = { flawed: 3, partial: 2, complete: 1 };

export function derive(a: Analysis): Derived {
  const n = a.files.length;
  const issuesByFile = new Map<number, Issue[]>();
  const worstSeverity: (Severity | undefined)[] = new Array(n);
  for (const issue of a.issues) {
    // Directory-wide issues (crowded dir) have no files; package cycles touch many files mildly.
    for (const f of issue.files) {
      const list = issuesByFile.get(f) ?? [];
      list.push(issue);
      issuesByFile.set(f, list);
      if (!worstSeverity[f] || SEV[issue.severity] > SEV[worstSeverity[f]!]) worstSeverity[f] = issue.severity;
    }
  }
  const patternsByFile = new Map<number, PatternMatch[]>();
  const worstVerdict: (PatternVerdict | undefined)[] = new Array(n);
  for (const p of a.patterns) {
    for (const f of p.files) {
      const list = patternsByFile.get(f) ?? [];
      list.push(p);
      patternsByFile.set(f, list);
      if (!worstVerdict[f] || VERDICT[p.verdict] > VERDICT[worstVerdict[f]!]) worstVerdict[f] = p.verdict;
    }
  }
  const outSets = Array.from({ length: n }, () => new Set<number>());
  const inSets = Array.from({ length: n }, () => new Set<number>());
  for (const e of a.edges) {
    outSets[e.from].add(e.to);
    inSets[e.to].add(e.from);
  }
  const outgoing = outSets.map((s) => [...s]);
  const incoming = inSets.map((s) => [...s]);
  let maxDegree = 1;
  for (let i = 0; i < n; i++) maxDegree = Math.max(maxDegree, outgoing[i].length + incoming[i].length);

  const filesUnder = new Map<string, number[]>();
  const dirSet = new Set(a.dirs.map((d) => d.path));
  for (const f of a.files) {
    let p: string | null = f.dir;
    for (;;) {
      if (dirSet.has(p)) {
        const list = filesUnder.get(p) ?? [];
        list.push(f.id);
        filesUnder.set(p, list);
      }
      if (p === "") break;
      p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    }
  }

  return {
    issuesByFile, worstSeverity, patternsByFile, worstVerdict, outgoing, incoming, maxDegree,
    issueById: new Map(a.issues.map((i) => [i.id, i])),
    patternById: new Map(a.patterns.map((p) => [p.id, p])),
    filesUnder, dirSet,
  };
}
