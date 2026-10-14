import { describe, expect, it } from "vitest";
import { analyze } from "./analyze";
import { layoutCity, squarify } from "./layout";

function run(files: Record<string, string>) {
  return analyze({
    repo: { owner: "o", repo: "r", ref: "main", sha: "x" },
    entries: Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
    contents: new Map(Object.entries(files)),
    configs: [{ path: "go.mod", text: "module example.com/app\n" }],
    skipped: [],
    treeTruncated: false,
    startedAt: Date.now(),
  });
}

describe("squarify", () => {
  it("fills the rectangle exactly with proportional areas", () => {
    const items = [6, 6, 4, 3, 2, 2, 1].map((weight) => ({ weight }));
    const out = squarify(items, { x: 0, z: 0, w: 6, d: 4 });
    const area = out.reduce((s, r) => s + r.rect.w * r.rect.d, 0);
    expect(area).toBeCloseTo(24, 6);
    for (const { item, rect } of out) expect(rect.w * rect.d).toBeCloseTo((item.weight / 24) * 24, 6);
  });
});

describe("city layout", () => {
  const files: Record<string, string> = {};
  for (let d = 0; d < 6; d++) for (let f = 0; f < 15; f++) files[`src/mod${d}/sub${f % 3}/file${f}.ts`] = `export const x${f} = ${f};\n`.repeat(1 + ((f * 7) % 40));
  const a = run(files);
  const city = layoutCity(a.files, a.dirs);

  it("places every file exactly once", () => {
    expect(city.towers.length).toBe(a.files.length);
    expect(new Set(city.towers.map((t) => t.file)).size).toBe(a.files.length);
  });

  it("never overlaps towers", () => {
    const t = city.towers;
    for (let i = 0; i < t.length; i++) {
      for (let j = i + 1; j < t.length; j++) {
        const overlapX = Math.abs(t[i].x - t[j].x) < (t[i].w + t[j].w) / 2 - 1e-6;
        const overlapZ = Math.abs(t[i].z - t[j].z) < (t[i].w + t[j].w) / 2 - 1e-6;
        expect(overlapX && overlapZ).toBe(false);
      }
    }
  });

  it("keeps towers inside their folder's platform", () => {
    for (const t of city.towers) {
      const p = city.platformByDir.get(a.files[t.file].dir)!;
      expect(t.x - t.w / 2).toBeGreaterThanOrEqual(p.x - p.w / 2 - 1e-6);
      expect(t.x + t.w / 2).toBeLessThanOrEqual(p.x + p.w / 2 + 1e-6);
      expect(t.z - t.w / 2).toBeGreaterThanOrEqual(p.z - p.d / 2 - 1e-6);
      expect(t.z + t.w / 2).toBeLessThanOrEqual(p.z + p.d / 2 + 1e-6);
      expect(t.y).toBeGreaterThan(p.y);
    }
  });
});

describe("rules", () => {
  it("does not report same-package Go references as cycles", () => {
    const a = run({
      "pkg/a.go": "package pkg\nfunc A() { B() }\n",
      "pkg/b.go": "package pkg\nfunc B() { A() }\n",
    });
    expect(a.edges.length).toBeGreaterThan(0);
    expect(a.issues.filter((i) => i.rule === "cycle")).toEqual([]);
  });

  it("flags oversized files and long methods", () => {
    const body = Array.from({ length: 700 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const a = run({ "src/big.ts": `export function huge() {\n${body}\n}\n` });
    expect(a.issues.map((i) => i.rule)).toEqual(expect.arrayContaining(["god-file", "long-method"]));
    expect(a.issues.find((i) => i.rule === "long-method")?.severity).toBe("error");
  });

  it("does not take HTTP verb methods for factories", () => {
    const a = run({
      "src/routes.ts": `export interface Routes { GET(path: string): Routes; POST(path: string): Routes }\nexport class Router implements Routes { GET(p: string) { return new Router() } POST(p: string) { return new Router() } }`,
    });
    expect(a.patterns.filter((p) => p.pattern.includes("factory"))).toEqual([]);
  });
});

describe("python lazy imports", () => {
  it("keeps function-local imports as dependencies but not as cycles", () => {
    const a = run({
      "pkg/__init__.py": "",
      "pkg/app.py": "from .helpers import h\nclass App:\n    pass\n",
      "pkg/helpers.py": "def h():\n    from .app import App\n    return App()\n",
    });
    expect(a.edges.filter((e) => e.kind === "import").length).toBe(2);
    expect(a.edges.find((e) => a.files[e.from].name === "helpers.py")?.lazy).toBe(true);
    expect(a.issues.filter((i) => i.rule === "cycle")).toEqual([]);
  });
});

describe("python TYPE_CHECKING classes", () => {
  it("does not turn type-only subclasses into cycles", () => {
    const a = run({
      "pkg/__init__.py": "",
      "pkg/app.py": "from .globals import g\nclass Flask:\n    pass\n",
      "pkg/globals.py": "import typing as t\nif t.TYPE_CHECKING:\n    from .app import Flask\n    class FlaskProxy(Flask): ...\ng = 1\n",
    });
    expect(a.edges.some((e) => e.kind === "inherit" && e.lazy)).toBe(true);
    expect(a.issues.filter((i) => i.rule === "cycle")).toEqual([]);
  });
});
