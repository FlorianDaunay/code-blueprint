import { describe, expect, it } from "vitest";
import { analyze } from "./analyze";
import type { Analysis } from "./model";

function run(files: Record<string, string>, configs: Record<string, string> = {}): Analysis {
  const entries = Object.entries(files).map(([path, text]) => ({ path, size: text.length }));
  return analyze({
    repo: { owner: "o", repo: "r", ref: "main", sha: "x" },
    entries,
    contents: new Map(Object.entries(files)),
    configs: Object.entries(configs).map(([path, text]) => ({ path, text })),
    skipped: [],
    treeTruncated: false,
    startedAt: Date.now(),
  });
}

const edge = (a: Analysis, from: string, to: string) => {
  const f = a.files.find((x) => x.path === from)!.id;
  const t = a.files.find((x) => x.path === to)!.id;
  return a.edges.some((e) => e.from === f && e.to === t);
};

const pattern = (a: Analysis, id: string, name?: string) => a.patterns.find((p) => p.pattern === id && (!name || p.roles[0].types.some((t) => t.name === name)));

describe("typescript project", () => {
  const a = run(
    {
      "src/index.ts": `import { Bus } from "./events/bus"; import { Shop } from "@/shop/shop"; Bus.getInstance();`,
      "src/events/bus.ts": `
import type { Listener } from "./listener";
export class Bus {
  private static instance: Bus;
  private listeners: Listener[] = [];
  private constructor() {}
  static getInstance(): Bus { if (!Bus.instance) { Bus.instance = new Bus(); } return Bus.instance; }
  subscribe(l: Listener) { this.listeners.push(l); }
  publish(e: string) { for (const l of this.listeners) l.onEvent(e); }
}`,
      "src/events/listener.ts": `export interface Listener { onEvent(e: string): void }`,
      "src/shop/shop.ts": `
import { PricingStrategy, Regular } from "./pricing";
import { util } from "../util/a";
export class Shop {
  constructor(private pricing: PricingStrategy) {}
  total(x: number) { return this.pricing.price(x); }
}`,
      "src/shop/pricing.ts": `
export interface PricingStrategy { price(x: number): number }
export class Regular implements PricingStrategy { price(x: number) { return x } }
export class Sale implements PricingStrategy { price(x: number) { return x * 0.8 } }`,
      "src/util/a.ts": `import { b } from "./b"; export const util = 1;`,
      "src/util/b.ts": `import { util } from "./a"; import { x } from "./missing"; export const b = 2;`,
      "src/core/model.ts": `import { Shop } from "../ui/view"; export class Model {}`,
      "src/ui/view.ts": `export class Shop {}`,
    },
    { "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } // c\n }`, "package.json": `{"name":"app"}` },
  );

  it("resolves relative and aliased imports", () => {
    expect(edge(a, "src/index.ts", "src/events/bus.ts")).toBe(true);
    expect(edge(a, "src/index.ts", "src/shop/shop.ts")).toBe(true);
    expect(edge(a, "src/shop/shop.ts", "src/shop/pricing.ts")).toBe(true);
  });

  it("reports cycles, broken imports and layer violations", () => {
    expect(a.issues.find((i) => i.rule === "cycle")?.files.length).toBe(2);
    expect(a.issues.find((i) => i.rule === "unresolved")?.detail).toContain("./missing");
    expect(a.issues.find((i) => i.rule === "layer")?.title).toContain("core → ui");
  });

  it("detects patterns with verdicts", () => {
    const s = pattern(a, "singleton", "Bus")!;
    expect(s).toBeTruthy();
    expect(s.checks.find((c) => c.label === "Constructor is closed")?.ok).toBe(true);
    const o = pattern(a, "observer", "Bus")!;
    expect(o.verdict).toBe("partial"); // no unsubscribe
    expect(o.checks.find((c) => c.label === "Observers can unsubscribe")?.ok).toBe(false);
    const st = pattern(a, "strategy")!;
    expect(st.roles.find((r) => r.role === "Context")?.types[0].name).toBe("Shop");
    expect(st.verdict).toBe("complete");
  });
});

describe("java project", () => {
  const a = run({
    "src/main/java/com/acme/shapes/Shape.java": `package com.acme.shapes; public interface Shape { double area(); void draw(); }`,
    "src/main/java/com/acme/shapes/Circle.java": `package com.acme.shapes; public class Circle implements Shape { public double area() { return 1; } public void draw() {} }`,
    "src/main/java/com/acme/shapes/Square.java": `package com.acme.shapes; public class Square implements Shape { public double area() { return 2; } public void draw() {} }`,
    "src/main/java/com/acme/shapes/Group.java": `package com.acme.shapes;
import java.util.*;
public class Group implements Shape {
  private final List<Shape> children = new ArrayList<>();
  public void add(Shape s) { children.add(s); }
  public double area() { double t = 0; for (Shape s : children) t += s.area(); return t; }
  public void draw() { for (Shape s : children) s.draw(); }
}`,
    "src/main/java/com/acme/shapes/Bordered.java": `package com.acme.shapes;
public class Bordered implements Shape {
  private final Shape inner;
  public Bordered(Shape inner) { this.inner = inner; }
  public double area() { return inner.area(); }
  public void draw() { inner.draw(); }
}`,
    "src/main/java/com/acme/app/ShapeFactory.java": `package com.acme.app;
import com.acme.shapes.*;
public class ShapeFactory {
  public static Shape create(String kind) {
    switch (kind) { case "c": return new Circle(); case "s": return new Square(); default: throw new IllegalArgumentException(kind); }
  }
}`,
    "src/main/java/com/acme/app/Main.java": `package com.acme.app;
import com.acme.shapes.Circle;
public class Main { public static void main(String[] a) { Shape s = ShapeFactory.create("c"); new Circle(); } }`,
    "src/main/java/com/acme/app/Config.java": `package com.acme.app;
public class Config {
  private static Config instance;
  public Config() {}
  public static Config getInstance() { if (instance == null) instance = new Config(); return instance; }
}`,
  });

  it("resolves wildcard, explicit and same-package references", () => {
    expect(edge(a, "src/main/java/com/acme/app/ShapeFactory.java", "src/main/java/com/acme/shapes/Circle.java")).toBe(true);
    expect(edge(a, "src/main/java/com/acme/app/Main.java", "src/main/java/com/acme/app/ShapeFactory.java")).toBe(true);
    expect(edge(a, "src/main/java/com/acme/shapes/Group.java", "src/main/java/com/acme/shapes/Shape.java")).toBe(true);
  });

  it("detects composite, decorator and a flawed factory and singleton", () => {
    expect(pattern(a, "composite", "Group")?.verdict).toBe("partial"); // no remove()
    expect(pattern(a, "decorator", "Bordered")?.verdict).toBe("complete");
    const f = pattern(a, "factory", "ShapeFactory")!;
    expect(f.verdict).toBe("flawed"); // Main still does `new Circle()`
    const s = pattern(a, "singleton", "Config")!;
    expect(s.verdict).toBe("flawed");
    expect(s.checks.filter((c) => !c.ok).map((c) => c.label)).toEqual(["Constructor is closed", "Thread-safe initialisation", "Cannot be subclassed"]);
  });
});

describe("python project", () => {
  const a = run({
    "app/__init__.py": "",
    "app/models/__init__.py": "",
    "app/models/user.py": "class User:\n    pass\n",
    "app/repo.py": `from app.models.user import User
from .builder import QueryBuilder

class UserRepository:
    def find_by_id(self, id) -> User:
        return User()
    def save(self, user: User):
        pass
    def delete(self, user):
        pass
`,
    "app/builder.py": `class QueryBuilder:
    def __init__(self):
        self._parts = []
    def where(self, c) -> "QueryBuilder":
        self._parts.append(c)
        return self
    def order(self, c):
        self._parts.append(c)
        return self
    def build(self) -> str:
        if not self._parts:
            raise ValueError("empty")
        return " ".join(self._parts)
`,
  });

  it("resolves absolute and relative imports", () => {
    expect(edge(a, "app/repo.py", "app/models/user.py")).toBe(true);
    expect(edge(a, "app/repo.py", "app/builder.py")).toBe(true);
  });

  it("detects repository and builder", () => {
    const r = pattern(a, "repository", "UserRepository")!;
    expect(r.verdict).toBe("partial"); // no interface
    expect(pattern(a, "builder", "QueryBuilder")?.checks.find((c) => c.label === "Validates before building")?.ok).toBe(true);
  });
});

describe("go project", () => {
  const a = run(
    {
      "go.mod": "",
      "cmd/main.go": `package main
import "github.com/acme/app/internal/store"
func main() { store.GetInstance() }`,
      "internal/store/store.go": `package store
import "sync"
type store struct { items map[string]string }
var (
	instance *store
	once sync.Once
)
func GetInstance() *store {
	once.Do(func() { instance = &store{} })
	return instance
}`,
      "internal/store/util.go": `package store
func helper() *store { return GetInstance() }`,
    },
    { "go.mod": "module github.com/acme/app\n\ngo 1.22\n" },
  );

  it("resolves module imports and same-package references", () => {
    expect(edge(a, "cmd/main.go", "internal/store/store.go")).toBe(true);
    expect(edge(a, "internal/store/util.go", "internal/store/store.go")).toBe(true);
  });

  it("detects a sync.Once singleton", () => {
    expect(pattern(a, "singleton")?.verdict).toBe("complete");
  });
});
