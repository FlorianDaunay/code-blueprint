import type { DirNode, Edge, FileNode } from "./model";

/** Directory tree with aggregated sizes. The root directory has path "". */
export function buildDirs(files: FileNode[]): DirNode[] {
  const dirs = new Map<string, DirNode>();
  const ensure = (path: string): DirNode => {
    let d = dirs.get(path);
    if (d) return d;
    const parent = path === "" ? null : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    d = { path, name: path === "" ? "/" : path.slice(path.lastIndexOf("/") + 1), parent, depth: path === "" ? 0 : path.split("/").length, children: [], files: [], loc: 0, fileCount: 0 };
    dirs.set(path, d);
    if (parent !== null) ensure(parent).children.push(path);
    return d;
  };
  ensure("");
  for (const f of files) {
    ensure(f.dir).files.push(f.id);
    let p: string | null = f.dir;
    while (p !== null) {
      const d: DirNode = dirs.get(p)!;
      d.loc += f.loc;
      d.fileCount++;
      p = d.parent;
    }
  }
  for (const d of dirs.values()) d.children.sort();
  return [...dirs.values()];
}

/** Collapses chains of single-child directories with no files (`src/main/java/com/acme` → one level). */
export function compactDirs(dirs: DirNode[]): DirNode[] {
  const byPath = new Map(dirs.map((d) => [d.path, { ...d, children: [...d.children] }]));
  const root = byPath.get("")!;
  const visit = (d: DirNode) => {
    d.children = d.children.map((c) => {
      let child = byPath.get(c)!;
      while (child.files.length === 0 && child.children.length === 1) {
        const only = byPath.get(child.children[0])!;
        byPath.delete(child.path);
        only.name = `${child.name}/${only.name}`;
        only.parent = d.path;
        child = only;
      }
      return child.path;
    });
    for (const c of d.children) visit(byPath.get(c)!);
  };
  visit(root);
  const out = [...byPath.values()];
  const depthOf = (d: DirNode): number => (d.parent === null ? 0 : depthOf(byPath.get(d.parent)!) + 1);
  for (const d of out) d.depth = depthOf(d);
  return out;
}

export interface Degree {
  fanIn: number[];
  fanOut: number[];
}

export function degrees(count: number, edges: Edge[]): Degree {
  const fanIn = new Array<number>(count).fill(0);
  const fanOut = new Array<number>(count).fill(0);
  const seen = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fanOut[e.from]++;
    fanIn[e.to]++;
  }
  return { fanIn, fanOut };
}

/** Adjacency lists, deduplicated across edge kinds. */
export function adjacency(count: number, edges: Edge[]): number[][] {
  const adj: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (const e of edges) if (e.from !== e.to) adj[e.from].add(e.to);
  return adj.map((s) => [...s]);
}

/** Tarjan's strongly connected components (iterative); returns components with more than one node. */
export function stronglyConnected(adj: number[][]): number[][] {
  const n = adj.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const result: number[][] = [];
  let counter = 0;
  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) continue;
    const work: [number, number][] = [[start, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      if (i === 0) {
        index[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = true;
      }
      if (i < adj[v].length) {
        frame[1]++;
        const w = adj[v][i];
        if (index[w] === -1) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1) result.push(comp.sort((a, b) => a - b));
      }
    }
  }
  return result;
}

/** A shortest cycle through `start` inside a component (BFS), for display. */
export function shortestCycle(adj: number[][], start: number, within: Set<number>): number[] {
  const prev = new Map<number, number>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of adj[v]) {
      if (!within.has(w)) continue;
      if (w === start) {
        const path = [v];
        let c = v;
        while (c !== start) {
          c = prev.get(c)!;
          path.push(c);
        }
        return path.reverse();
      }
      if (!seen.has(w)) {
        seen.add(w);
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start];
}
