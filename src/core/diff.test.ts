import { describe, expect, it } from "vitest";
import { analyze } from "./analyze";
import { diffAnalyses } from "./diff";

function run(ref: string, files: Record<string, string>) {
  return analyze({
    repo: { owner: "o", repo: "r", ref, sha: ref },
    // Blob = content itself: identical text ⇒ identical "sha".
    entries: Object.entries(files).map(([path, text]) => ({ path, size: text.length, sha: text })),
    contents: new Map(Object.entries(files)),
    configs: [],
    skipped: [],
    treeTruncated: false,
    startedAt: Date.now(),
  });
}

describe("diffAnalyses", () => {
  const base = run("v1", {
    "src/a.ts": `import { b } from "./b";\nexport const a = b;\n`,
    "src/b.ts": `export const b = 1;\n`,
    "src/old.ts": `import { a } from "./a";\nexport const old = a;\n`,
    "src/cfg.ts": `export class Config {\n  private static instance: Config;\n  private constructor() {}\n  static getInstance(): Config { if (!Config.instance) Config.instance = new Config(); return Config.instance; }\n}\n`,
  });
  const head = run("v2", {
    "src/a.ts": `import { b } from "./b";\nimport { c } from "./c";\nexport const a = b + c;\n`,
    "src/b.ts": `export const b = 1;\n`,
    "src/c.ts": `import { a } from "./a";\nexport const c = 2;\n`,
    "src/cfg.ts": `export class Config {\n  private static instance: Config;\n  constructor() {}\n  static getInstance(): Config { if (!Config.instance) Config.instance = new Config(); return Config.instance; }\n}\n`,
  });
  const { combined, diff } = diffAnalyses(base, head);
  const id = (path: string) => combined.files.find((f) => f.path === path)!.id;

  it("keeps head ids and appends removed files", () => {
    expect(combined.files.slice(0, head.files.length).map((f) => f.path)).toEqual(head.files.map((f) => f.path));
    expect(combined.files.length).toBe(head.files.length + 1);
    expect(combined.dirs.find((d) => d.path === "src")?.files).toContain(id("src/old.ts"));
  });

  it("classifies files", () => {
    expect(diff.status[id("src/a.ts")]).toBe("modified");
    expect(diff.status[id("src/b.ts")]).toBe("unchanged");
    expect(diff.status[id("src/c.ts")]).toBe("added");
    expect(diff.status[id("src/old.ts")]).toBe("removed");
    expect(diff.stats).toMatchObject({ added: 1, removed: 1, modified: 2, unchanged: 1 });
  });

  it("finds added and removed dependencies", () => {
    expect(diff.addedEdges).toEqual(expect.arrayContaining([[id("src/a.ts"), id("src/c.ts")], [id("src/c.ts"), id("src/a.ts")]]));
    expect(diff.removedEdges).toEqual([[id("src/old.ts"), id("src/a.ts")]]);
  });

  it("reports introduced issues and pattern regressions", () => {
    expect(diff.introducedIssues.map((i) => i.rule)).toContain("cycle");
    const change = diff.patternChanges.find((c) => c.match.pattern === "singleton")!;
    expect(change).toMatchObject({ kind: "regressed", from: "complete", to: "flawed" });
  });
});
