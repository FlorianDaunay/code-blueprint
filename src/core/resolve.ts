import type { Edge, FileNode, ImportInfo, TypeInfo } from "./model";

/**
 * Turns per-file imports into file → file edges, per language:
 * - TS/JS: relative paths, tsconfig `paths`/`baseUrl`, `@/`/`~/` aliases, workspace packages.
 * - Python: relative imports, package roots found through `__init__.py`, suffix matching.
 * - Java/Kotlin/C#/PHP: fully-qualified type index + namespace visibility + referenced identifiers.
 * - Go: go.mod module path → package directory, `alias.Name` selectors, same-package references.
 */

export interface TsConfigInfo {
  /** Directory of the tsconfig/jsconfig ("" for root). */
  dir: string;
  baseUrl?: string;
  paths: Record<string, string[]>;
}

export interface ResolverConfig {
  tsconfigs: TsConfigInfo[];
  /** Workspace package name → directory. */
  workspaces: Record<string, string>;
  /** Package.json directories (for `@/` alias guesses). */
  packageDirs: string[];
  goModules: { dir: string; module: string }[];
  psr4: { prefix: string; dir: string }[];
}

export const emptyConfig = (): ResolverConfig => ({ tsconfigs: [], workspaces: {}, packageDirs: [], goModules: [], psr4: [] });

const JS_EXTS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte"];
const ASSET = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|json|md|mdx|html|txt|wasm|woff2?|ttf|glsl|graphql|gql|yaml|yml)(\?.*)?$/i;
const NODE_BUILTINS = new Set(["fs", "path", "os", "http", "https", "url", "util", "crypto", "stream", "events", "child_process", "zlib", "net", "tls", "dns", "assert", "buffer", "querystring", "readline", "worker_threads", "cluster", "module", "process", "timers", "vm", "perf_hooks", "v8", "tty"]);

export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (...parts: string[]) => normalizePath(parts.filter(Boolean).join("/"));

/** Parses JSON with comments and trailing commas (tsconfig style). */
export function parseLooseJson(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
}

/** Reads resolver hints from the small config files of the repo. */
export function readConfigs(configs: { path: string; text: string }[]): ResolverConfig {
  const cfg = emptyConfig();
  for (const { path, text } of configs) {
    const dir = dirname(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    try {
      if (/^(tsconfig.*|jsconfig)\.json$/.test(name)) {
        const json = parseLooseJson(text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
        const co = json.compilerOptions ?? {};
        if (co.baseUrl || co.paths) cfg.tsconfigs.push({ dir, baseUrl: co.baseUrl, paths: co.paths ?? {} });
      } else if (name === "package.json") {
        const json = JSON.parse(text) as { name?: string };
        cfg.packageDirs.push(dir);
        // The root package counts too: examples/tests often require the package by its own name.
        if (json.name && !(json.name in cfg.workspaces && dir === "")) cfg.workspaces[json.name] = dir;
      } else if (name === "go.mod") {
        const module = /^\s*module\s+(\S+)/m.exec(text)?.[1];
        if (module) cfg.goModules.push({ dir, module });
      } else if (name === "composer.json") {
        const json = JSON.parse(text) as { autoload?: { "psr-4"?: Record<string, string | string[]> } };
        for (const [prefix, dirs] of Object.entries(json.autoload?.["psr-4"] ?? {})) {
          for (const d of Array.isArray(dirs) ? dirs : [dirs]) cfg.psr4.push({ prefix: prefix.replace(/\\+$/, ""), dir: join(dir, d) });
        }
      }
    } catch {
      // A broken config file only means fewer resolved imports.
    }
  }
  // Nearest config first.
  cfg.tsconfigs.sort((a, b) => b.dir.length - a.dir.length);
  cfg.goModules.sort((a, b) => b.dir.length - a.dir.length);
  return cfg;
}

export interface ResolveResult {
  edges: Edge[];
}

class EdgeSet {
  private map = new Map<string, Edge>();
  add(from: number, to: number, kind: Edge["kind"], weight = 1) {
    if (from === to) return;
    const key = `${from}>${to}>${kind}`;
    const e = this.map.get(key);
    if (e) e.weight += weight;
    else this.map.set(key, { from, to, kind, weight });
  }
  has(from: number, to: number) {
    return this.map.has(`${from}>${to}>import`);
  }
  list() {
    return [...this.map.values()];
  }
}

export function resolveImports(files: FileNode[], cfg: ResolverConfig): ResolveResult {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const byDir = new Map<string, FileNode[]>();
  for (const f of files) {
    const list = byDir.get(f.dir) ?? [];
    list.push(f);
    byDir.set(f.dir, list);
  }
  const edges = new EdgeSet();
  const externals = (f: FileNode, name: string) => {
    if (!f.externals.includes(name)) f.externals.push(name);
  };
  const unresolved = (f: FileNode, spec: string) => {
    if (!f.unresolved.includes(spec)) f.unresolved.push(spec);
  };

  // ---------- TS / JS ----------
  const tryJs = (base: string): FileNode | undefined => {
    const direct = byPath.get(base);
    if (direct && direct.lang !== "other") return direct;
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    for (const b of stripped !== base ? [stripped, base] : [base]) {
      for (const ext of JS_EXTS) {
        const hit = byPath.get(`${b}.${ext}`);
        if (hit) return hit;
      }
      for (const ext of JS_EXTS) {
        const hit = byPath.get(`${b ? b + "/" : ""}index.${ext}`);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const nearest = <T extends { dir: string }>(list: T[], path: string) => list.find((c) => c.dir === "" || path === c.dir || path.startsWith(c.dir + "/"));
  const resolveJs = (f: FileNode, spec: string): FileNode | "external" | undefined => {
    if (spec.startsWith(".")) return tryJs(join(f.dir, spec));
    if (spec.startsWith("/")) return tryJs(normalizePath(spec));
    const ts = nearest(cfg.tsconfigs, f.path);
    if (ts) {
      for (const [key, targets] of Object.entries(ts.paths)) {
        const star = key.indexOf("*");
        const matches = star >= 0 ? spec.startsWith(key.slice(0, star)) && spec.endsWith(key.slice(star + 1)) : spec === key;
        if (!matches) continue;
        const rest = star >= 0 ? spec.slice(star, spec.length - (key.length - star - 1)) : "";
        for (const target of targets) {
          const hit = tryJs(join(ts.dir, ts.baseUrl ?? "", target.replace("*", rest)));
          if (hit) return hit;
        }
      }
      if (ts.baseUrl) {
        const hit = tryJs(join(ts.dir, ts.baseUrl, spec));
        if (hit) return hit;
      }
    }
    const alias = /^[@~#]\/(.*)$/.exec(spec);
    if (alias) {
      const pkg = nearest([...cfg.packageDirs].sort((a, b) => b.length - a.length).map((dir) => ({ dir })), f.path)?.dir ?? "";
      return tryJs(join(pkg, "src", alias[1])) ?? tryJs(join(pkg, alias[1])) ?? tryJs(join("src", alias[1]));
    }
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    const ws = cfg.workspaces[name];
    if (ws) {
      const sub = spec.slice(name.length + 1);
      return (sub ? tryJs(join(ws, sub)) ?? tryJs(join(ws, "src", sub)) : tryJs(join(ws, "src", "index")) ?? tryJs(join(ws, "index")) ?? tryJs(join(ws, "lib", "index"))) ?? "external";
    }
    return "external";
  };

  // ---------- Python ----------
  const pyFiles = files.filter((f) => f.lang === "python");
  const hasInit = new Set(pyFiles.filter((f) => f.name === "__init__.py").map((f) => f.dir));
  const pyModules = new Map<string, FileNode[]>();
  const addModule = (key: string, f: FileNode) => {
    const list = pyModules.get(key) ?? [];
    list.push(f);
    pyModules.set(key, list);
  };
  for (const f of pyFiles) {
    const modPath = f.name === "__init__.py" ? f.dir : f.path.replace(/\.pyi?$/, "");
    const parts = modPath.split("/").filter(Boolean);
    // Every suffix is a candidate dotted name; canonical names (package roots) are preferred later.
    for (let k = 0; k < parts.length; k++) addModule(parts.slice(k).join("."), f);
  }
  const canonicalRootLen = (f: FileNode) => {
    let dir = f.dir;
    let depth = 0;
    while (dir && hasInit.has(dir)) {
      dir = dirname(dir);
      depth++;
    }
    return depth;
  };
  const resolvePyAbsolute = (from: FileNode, dotted: string): FileNode | undefined => {
    const candidates = pyModules.get(dotted);
    if (!candidates?.length) return undefined;
    if (candidates.length === 1) return candidates[0];
    const segs = dotted.split(".").length;
    // Prefer a module whose canonical dotted name is exactly `dotted`, then the one closest to the importer.
    const exact = candidates.filter((c) => {
      const own = c.name === "__init__.py" ? 0 : 1;
      return canonicalRootLen(c) + own === segs || (c.name === "__init__.py" && canonicalRootLen(c) === segs);
    });
    const pool = exact.length ? exact : candidates;
    return pool.sort((a, b) => sharedPrefix(b.path, from.path) - sharedPrefix(a.path, from.path) || a.path.length - b.path.length)[0];
  };
  const resolvePy = (f: FileNode, imp: ImportInfo): FileNode[] => {
    const hits: FileNode[] = [];
    if (imp.level && imp.level > 0) {
      let base = f.dir;
      for (let k = 1; k < imp.level; k++) base = dirname(base);
      const modDir = join(base, imp.spec.replace(/\./g, "/"));
      const mod = imp.spec ? byPath.get(`${modDir}.py`) ?? byPath.get(`${modDir}/__init__.py`) : undefined;
      if (mod) hits.push(mod);
      for (const n of imp.names) {
        const sub = byPath.get(`${modDir}/${n}.py`) ?? byPath.get(`${modDir}/${n}/__init__.py`);
        if (sub) hits.push(sub);
      }
      if (!imp.spec && hits.length === 0) {
        const init = byPath.get(`${base}/__init__.py`);
        if (init) hits.push(init);
      }
      return hits;
    }
    const mod = resolvePyAbsolute(f, imp.spec);
    if (mod) hits.push(mod);
    for (const n of imp.names) {
      if (n === "*") continue;
      const sub = pyModules.get(`${imp.spec}.${n}`) ? resolvePyAbsolute(f, `${imp.spec}.${n}`) : undefined;
      if (sub) hits.push(sub);
    }
    return hits;
  };
  const localPyRoots = new Set(pyFiles.map((f) => f.path.split("/")[0].replace(/\.py$/, "")));

  // ---------- JVM / C# / PHP: type index ----------
  const fqn = new Map<string, FileNode[]>();
  const nsTypes = new Map<string, Map<string, FileNode[]>>();
  const nsSep = (lang: string) => (lang === "php" ? "\\" : ".");
  for (const f of files) {
    if (!f.source || !["java", "kotlin", "csharp", "php"].includes(f.lang)) continue;
    const declared: { name: string; ns: string }[] = f.source.types.map((t: TypeInfo) => ({ name: t.name, ns: t.namespace ?? f.source!.namespace ?? "" }));
    if (f.lang === "kotlin") for (const fn of [...f.source.functions, ...f.source.variables]) declared.push({ name: fn.name, ns: f.source.namespace ?? "" });
    for (const { name, ns } of declared) {
      const key = ns ? `${ns}${nsSep(f.lang)}${name}` : name;
      const list = fqn.get(key) ?? [];
      if (!list.includes(f)) list.push(f);
      fqn.set(key, list);
      const byName = nsTypes.get(ns) ?? new Map<string, FileNode[]>();
      const l2 = byName.get(name) ?? [];
      if (!l2.includes(f)) l2.push(f);
      byName.set(name, l2);
      nsTypes.set(ns, byName);
    }
  }

  const resolveTyped = (f: FileNode) => {
    const src = f.source!;
    const sep = nsSep(f.lang);
    const visible = new Map<string, FileNode[]>();
    const addNs = (ns: string) => {
      for (const [name, list] of nsTypes.get(ns) ?? []) visible.set(name, [...(visible.get(name) ?? []), ...list]);
    };
    // Own namespace(s), and parents for C#.
    const ownNs = new Set<string>([src.namespace ?? "", ...src.types.map((t) => t.namespace ?? "")]);
    for (const ns of ownNs) {
      addNs(ns);
      if (f.lang === "csharp") {
        const parts = ns.split(".");
        for (let k = parts.length - 1; k > 0; k--) addNs(parts.slice(0, k).join("."));
      }
    }
    for (const imp of src.imports) {
      if (imp.kind === "include") {
        const target = byPath.get(join(f.dir, imp.spec)) ?? byPath.get(normalizePath(imp.spec));
        if (target) edges.add(f.id, target.id, "import");
        else unresolved(f, imp.spec);
        continue;
      }
      if (imp.kind === "namespace") {
        if (nsTypes.has(imp.spec)) addNs(imp.spec);
        else if (!isLocalSpec(imp.spec)) externals(f, externalName(imp.spec, f.lang));
        continue;
      }
      let targets = fqn.get(imp.spec);
      // Nested type `a.b.Outer.Inner` or member import → retry on the parent.
      if (!targets && imp.spec.includes(sep)) targets = fqn.get(imp.spec.slice(0, imp.spec.lastIndexOf(sep)));
      if (!targets && f.lang === "php") targets = psr4File(imp.spec);
      if (targets) {
        for (const t of targets) edges.add(f.id, t.id, "import");
        const local = imp.alias ?? imp.names[0];
        if (local) visible.set(local, targets);
      } else if (isLocalSpec(imp.spec)) unresolved(f, imp.spec);
      else externals(f, externalName(imp.spec, f.lang));
    }
    for (const ref of src.refs) {
      const targets = visible.get(ref);
      if (!targets) continue;
      // Ambiguous short names: prefer files in the same directory.
      const pick = targets.length > 1 ? targets.filter((t) => t.dir === f.dir) : targets;
      for (const t of pick.length ? pick : targets.slice(0, 1)) edges.add(f.id, t.id, "import");
    }
  };
  // Local only when the parent namespace exists in the repo (a shared root like `org.springframework` is not enough).
  const isLocalSpec = (spec: string) => {
    const cut = Math.max(spec.lastIndexOf("."), spec.lastIndexOf("\\"));
    return cut > 0 && nsTypes.has(spec.slice(0, cut));
  };
  const psr4File = (spec: string): FileNode[] | undefined => {
    for (const { prefix, dir } of cfg.psr4) {
      if (spec.startsWith(prefix + "\\")) {
        const hit = byPath.get(join(dir, spec.slice(prefix.length + 1).replace(/\\/g, "/") + ".php"));
        if (hit) return [hit];
      }
    }
    return undefined;
  };

  // ---------- Go ----------
  const goDecls = new Map<number, Set<string>>();
  for (const f of files) {
    if (f.lang !== "go" || !f.source) continue;
    const s = new Set<string>();
    for (const t of f.source.types) if (!t.decorators.includes("partial")) s.add(t.name);
    for (const fn of f.source.functions) s.add(fn.name);
    for (const v of f.source.variables) s.add(v.name);
    goDecls.set(f.id, s);
  }
  const resolveGo = (f: FileNode) => {
    const src = f.source!;
    const mod = nearest(cfg.goModules, f.path);
    const pkgOf = (d: string) => (byDir.get(d) ?? []).filter((x) => x.lang === "go" && x.source && (f.isTest || !x.path.endsWith("_test.go")));
    for (const imp of src.imports) {
      let dir: string | undefined;
      if (mod && (imp.spec === mod.module || imp.spec.startsWith(mod.module + "/"))) dir = join(mod.dir, imp.spec.slice(mod.module.length));
      else if (cfg.goModules.length === 0 && byDir.has(imp.spec.split("/").slice(3).join("/"))) dir = imp.spec.split("/").slice(3).join("/");
      if (dir === undefined) {
        if (imp.spec.split("/")[0].includes(".")) externals(f, imp.spec.split("/").slice(0, 3).join("/"));
        continue;
      }
      const pkg = pkgOf(dir);
      if (!pkg.length) {
        unresolved(f, imp.spec);
        continue;
      }
      const alias = imp.alias ?? imp.spec.slice(imp.spec.lastIndexOf("/") + 1);
      let linked = false;
      for (const sel of src.selectors) {
        if (!sel.startsWith(alias + ".")) continue;
        const name = sel.slice(alias.length + 1);
        for (const p of pkg) {
          if (goDecls.get(p.id)?.has(name)) {
            edges.add(f.id, p.id, "import");
            linked = true;
          }
        }
      }
      if (!linked) edges.add(f.id, pkg.sort((a, b) => b.loc - a.loc)[0].id, "import");
    }
    // Same package: references to names declared by sibling files.
    const refs = new Set(src.refs);
    for (const sib of pkgOf(f.dir)) {
      if (sib.id === f.id || sib.source?.namespace !== src.namespace) continue;
      let w = 0;
      for (const name of goDecls.get(sib.id) ?? []) if (refs.has(name)) w++;
      if (w) edges.add(f.id, sib.id, "import", w);
    }
  };

  for (const f of files) {
    if (!f.source) continue;
    switch (f.lang) {
      case "typescript":
      case "javascript":
        for (const imp of f.source.imports) {
          if (ASSET.test(imp.spec)) continue;
          const r = resolveJs(f, imp.spec);
          if (r === "external") {
            const name = imp.spec.startsWith("@") ? imp.spec.split("/").slice(0, 2).join("/") : imp.spec.split("/")[0];
            if (!name.startsWith("node:") && !NODE_BUILTINS.has(name)) externals(f, name);
          } else if (r) edges.add(f.id, r.id, "import");
          else unresolved(f, imp.spec);
        }
        break;
      case "python":
        for (const imp of f.source.imports) {
          const hits = resolvePy(f, imp);
          for (const h of hits) edges.add(f.id, h.id, "import");
          if (!hits.length) {
            const root = imp.spec.split(".")[0];
            if (imp.level || localPyRoots.has(root)) unresolved(f, ".".repeat(imp.level ?? 0) + imp.spec);
            else if (root) externals(f, root);
          }
        }
        break;
      case "java":
      case "kotlin":
      case "csharp":
      case "php":
        resolveTyped(f);
        break;
      case "go":
        resolveGo(f);
        break;
      default:
        break;
    }
  }
  return { edges: edges.list() };
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function externalName(spec: string, lang: string): string {
  const parts = spec.split(lang === "php" ? "\\" : ".");
  return parts.slice(0, Math.min(2, parts.length)).join(lang === "php" ? "\\" : ".");
}
