import type { DirNode, FileNode } from "./model";

/**
 * Code-city layout: a nested squarified treemap. Directories become stacked platforms,
 * files become towers (footprint ~ number of members, height ~ code lines).
 * Deterministic: the same analysis always gives the same city.
 */

export interface Tower {
  file: number;
  x: number;
  z: number;
  /** Footprint side. */
  w: number;
  h: number;
  /** Base elevation (top of its platform). */
  y: number;
}

export interface Platform {
  dir: string;
  x: number;
  z: number;
  w: number;
  d: number;
  y: number;
  level: number;
}

export interface CityLayout {
  towers: Tower[];
  /** Indexed by file id (undefined for files not placed). */
  towerByFile: (Tower | undefined)[];
  platforms: Platform[];
  platformByDir: Map<string, Platform>;
  size: number;
  maxHeight: number;
}

const GAP = 0.7;
const PAD = 0.9;
const LEVEL_H = 0.42;
const MAX_H = 42;

export function towerSide(f: FileNode): number {
  const members = f.source ? f.source.types.reduce((s, t) => s + t.methods.length + t.fields.length, 0) + f.source.functions.length : Math.sqrt(f.loc);
  return Math.min(5.5, 1 + 0.42 * Math.sqrt(members));
}

export function towerHeight(f: FileNode): number {
  return Math.min(MAX_H, 0.6 + Math.pow(f.loc, 0.6) * 0.2);
}

interface Item {
  weight: number;
  kind: "dir" | "file";
  key: string;
  id: number;
}

interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** Squarified treemap (Bruls, Huizing, van Wijk) of `items` into `rect`. */
export function squarify<T extends { weight: number }>(items: T[], rect: Rect): { item: T; rect: Rect }[] {
  const out: { item: T; rect: Rect }[] = [];
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (!items.length || total <= 0) return out;
  const scale = (rect.w * rect.d) / total;
  const queue = items.map((item) => ({ item, area: item.weight * scale }));
  let r = { ...rect };

  const worst = (row: { area: number }[], side: number) => {
    const sum = row.reduce((s, i) => s + i.area, 0);
    let max = 0;
    let min = Infinity;
    for (const i of row) {
      max = Math.max(max, i.area);
      min = Math.min(min, i.area);
    }
    const s2 = sum * sum;
    const side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };

  while (queue.length) {
    const side = Math.min(r.w, r.d);
    const row = [queue.shift()!];
    while (queue.length && worst([...row, queue[0]], side) <= worst(row, side)) row.push(queue.shift()!);
    const sum = row.reduce((s, i) => s + i.area, 0);
    if (r.w >= r.d) {
      // Column on the left side.
      const colW = sum / r.d;
      let z = r.z;
      for (const i of row) {
        const d = i.area / colW;
        out.push({ item: i.item, rect: { x: r.x, z, w: colW, d } });
        z += d;
      }
      r = { x: r.x + colW, z: r.z, w: r.w - colW, d: r.d };
    } else {
      const rowD = sum / r.w;
      let x = r.x;
      for (const i of row) {
        const w = i.area / rowD;
        out.push({ item: i.item, rect: { x, z: r.z, w, d: rowD } });
        x += w;
      }
      r = { x: r.x, z: r.z + rowD, w: r.w, d: r.d - rowD };
    }
  }
  return out;
}

export function layoutCity(files: FileNode[], dirs: DirNode[]): CityLayout {
  const byPath = new Map(dirs.map((d) => [d.path, d]));
  const weights = new Map<string, number>();
  const fileWeight = (f: FileNode) => (towerSide(f) + GAP) ** 2;
  const dirWeight = (d: DirNode): number => {
    const cached = weights.get(d.path);
    if (cached !== undefined) return cached;
    let inner = 0;
    for (const id of d.files) inner += fileWeight(files[id]);
    for (const c of d.children) inner += dirWeight(byPath.get(c)!);
    // Inflate for the padding ring around children.
    const side = Math.sqrt(inner) * 1.04 + 2 * PAD;
    const w = side * side;
    weights.set(d.path, w);
    return w;
  };

  const root = byPath.get("")!;
  const rootSide = Math.sqrt(dirWeight(root));
  const towers: Tower[] = [];
  const towerByFile: (Tower | undefined)[] = new Array(files.length);
  const platforms: Platform[] = [];
  const platformByDir = new Map<string, Platform>();
  let maxHeight = 0;

  const place = (d: DirNode, rect: Rect, level: number) => {
    const platform: Platform = { dir: d.path, x: rect.x + rect.w / 2, z: rect.z + rect.d / 2, w: rect.w, d: rect.d, y: level * LEVEL_H, level };
    platforms.push(platform);
    platformByDir.set(d.path, platform);
    const inner: Rect = { x: rect.x + PAD, z: rect.z + PAD, w: Math.max(0.1, rect.w - 2 * PAD), d: Math.max(0.1, rect.d - 2 * PAD) };
    const items: Item[] = [
      ...d.children.map((c, i) => ({ weight: dirWeight(byPath.get(c)!), kind: "dir" as const, key: c, id: i })),
      ...d.files.map((id) => ({ weight: fileWeight(files[id]), kind: "file" as const, key: files[id].name, id })),
    ].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
    for (const { item, rect: r } of squarify(items, inner)) {
      if (item.kind === "dir") place(byPath.get(item.key)!, r, level + 1);
      else {
        const f = files[item.id];
        const side = Math.max(0.35, Math.min(towerSide(f), Math.min(r.w, r.d) - GAP));
        const h = towerHeight(f);
        const t: Tower = { file: f.id, x: r.x + r.w / 2, z: r.z + r.d / 2, w: side, h, y: (level + 1) * LEVEL_H };
        towers.push(t);
        towerByFile[f.id] = t;
        maxHeight = Math.max(maxHeight, h);
      }
    }
  };
  place(root, { x: -rootSide / 2, z: -rootSide / 2, w: rootSide, d: rootSide }, 0);
  return { towers, towerByFile, platforms, platformByDir, size: rootSide, maxHeight };
}
