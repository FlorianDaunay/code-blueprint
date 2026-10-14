import type { Edge, FileNode, Lang, TypeInfo } from "./model";
import { baseTypeName, splitTopLevel } from "./strip";

/** A type declaration placed in the repository-wide model. */
export interface TypeNode {
  id: number;
  file: number;
  lang: Lang;
  info: TypeInfo;
  /** Resolved super classes (extends). */
  parents: number[];
  /** Resolved interfaces (implements, Go implicit). */
  interfaces: number[];
  /** Types that extend or implement this one. */
  subs: number[];
}

export interface TypeModel {
  nodes: TypeNode[];
  /** Resolves a type name as seen from a file. */
  resolve(fromFile: number, name: string | undefined): TypeNode | undefined;
  isInterfaceLike(node: TypeNode): boolean;
  /** All transitive super types. */
  ancestors(node: TypeNode): TypeNode[];
  /** Depth of the inheritance chain (classes only, 0 = no parent). */
  depth(node: TypeNode): number;
}

const COLLECTIONS = new Set([
  "List", "ArrayList", "LinkedList", "Set", "HashSet", "TreeSet", "LinkedHashSet", "Collection", "Iterable", "IEnumerable",
  "ICollection", "IList", "IReadOnlyList", "IReadOnlyCollection", "ISet", "Array", "ReadonlyArray", "Vec", "MutableList", "MutableSet",
  "Sequence", "list", "set", "tuple", "frozenset", "Queue", "Deque", "ArrayDeque", "Stack", "ObservableCollection", "CopyOnWriteArrayList",
  "ConcurrentLinkedQueue", "WeakSet", "Iterator", "Sequence", "ConcurrentBag", "BlockingQueue",
]);
const MAPS = new Set(["Map", "HashMap", "TreeMap", "LinkedHashMap", "Dictionary", "IDictionary", "Record", "dict", "Dict", "MutableMap", "ConcurrentHashMap", "ConcurrentDictionary", "WeakMap", "Mapping", "DefaultDict", "defaultdict", "OrderedDict"]);

const WRAPPERS = new Set(["Lazy", "AtomicReference", "Optional", "WeakReference", "Promise", "Task", "ValueTask", "Future", "CompletableFuture", "CompletionStage", "Mono", "Maybe", "Single", "Deferred", "Option", "Awaitable", "Coroutine", "Ref", "ReadonlyRef", "Readonly", "Partial", "Required", "Nullable"]);
const STREAMS = new Set(["Stream", "Flux", "Observable", "Flow", "IQueryable", "IAsyncEnumerable", "Page", "Slice", "AsyncIterable", "AsyncIterator", "Generator", "Iterator", "PagedList"]);

export interface TypeExpr {
  base: string;
  isCollection: boolean;
  /** Element type for collections / maps (value type), or the type itself. */
  elem: string;
  nullable: boolean;
}

/** `List<Observer>` → collection of Observer; `Observer[]`, `[]Observer`, `map[string]Handler`, `Observer | null`... */
export function parseTypeExpr(raw: string | undefined): TypeExpr | undefined {
  if (!raw) return undefined;
  let t = raw.trim().replace(/^(readonly|final|const|volatile|static)\s+/g, "");
  const nullable = /\?$|\|\s*(null|undefined)|^\?|Optional\[|Option</.test(t);
  t = t.replace(/\s*\|\s*(null|undefined)\b/g, "").replace(/^\?/, "").replace(/\?$/, "").replace(/^Optional\[(.*)\]$/, "$1").trim();
  if (t.startsWith("[]")) {
    const elem = baseTypeName(t.slice(2));
    return { base: "[]", isCollection: true, elem, nullable };
  }
  const goMap = /^map\[[^\]]*\](.+)$/.exec(t);
  if (goMap) return { base: "map", isCollection: true, elem: baseTypeName(goMap[1]), nullable };
  if (t.endsWith("[]")) return { base: "[]", isCollection: true, elem: baseTypeName(t.slice(0, -2)), nullable };
  const generic = /^([\w.\\]+)\s*[<[]([\s\S]*)[>\]]$/.exec(t);
  if (generic) {
    const base = baseTypeName(generic[1]);
    const args = splitTopLevel(generic[2]);
    if (COLLECTIONS.has(base)) return { base, isCollection: true, elem: baseTypeName(stripFnType(args[0] ?? "")), nullable };
    if (MAPS.has(base)) return { base, isCollection: true, elem: baseTypeName(stripFnType(args[args.length - 1] ?? "")), nullable };
    if (WRAPPERS.has(base)) {
      // Unwrap containers of one value or async results: Optional<User> → User, Promise<List<User>> → collection of User.
      const inner = parseTypeExpr(args[0] ?? "");
      if (inner) return { ...inner, nullable: true };
    }
    if (STREAMS.has(base)) {
      const inner = parseTypeExpr(args[0] ?? "");
      return { base, isCollection: true, elem: inner?.elem ?? baseTypeName(args[0] ?? ""), nullable };
    }
    return { base, isCollection: false, elem: base, nullable };
  }
  const base = baseTypeName(t.replace(/^\*/, ""));
  return { base, isCollection: false, elem: base, nullable };
}

const stripFnType = (s: string) => s.replace(/^\(\s*\)\s*=>\s*/, "");

/** Builds the repository type model and adds inheritance edges between files. */
export function buildTypeModel(files: FileNode[], importEdges: Edge[]): { model: TypeModel; inheritEdges: Edge[] } {
  const nodes: TypeNode[] = [];
  const byName = new Map<string, TypeNode[]>();
  // Go: methods declared in another file of the package are merged into the struct.
  const goPartials: { file: FileNode; info: TypeInfo }[] = [];
  for (const f of files) {
    if (!f.source) continue;
    for (const info of f.source.types) {
      if (f.lang === "go" && info.decorators.includes("partial")) {
        goPartials.push({ file: f, info });
        continue;
      }
      const node: TypeNode = { id: nodes.length, file: f.id, lang: f.lang, info, parents: [], interfaces: [], subs: [] };
      nodes.push(node);
      const list = byName.get(info.name) ?? [];
      list.push(node);
      byName.set(info.name, list);
    }
  }
  for (const { file, info } of goPartials) {
    const target = (byName.get(info.name) ?? []).find((n) => files[n.file].dir === file.dir);
    if (target) target.info.methods.push(...info.methods);
  }

  const imports = new Map<number, Set<number>>();
  for (const e of importEdges) {
    const s = imports.get(e.from) ?? new Set<number>();
    s.add(e.to);
    imports.set(e.from, s);
  }

  const resolve = (fromFile: number, name: string | undefined): TypeNode | undefined => {
    if (!name) return undefined;
    const candidates = byName.get(baseTypeName(name));
    if (!candidates?.length) return undefined;
    if (candidates.length === 1) return candidates[0];
    const same = candidates.find((c) => c.file === fromFile);
    if (same) return same;
    const imported = imports.get(fromFile);
    const viaImport = imported && candidates.find((c) => imported.has(c.file));
    if (viaImport) return viaImport;
    const dir = files[fromFile]?.dir;
    return candidates.find((c) => files[c.file].dir === dir) ?? candidates[0];
  };

  const isInterfaceLike = (n: TypeNode) => n.info.kind === "interface" || n.info.kind === "trait";

  for (const n of nodes) {
    for (const name of n.info.extends) {
      const target = resolve(n.file, name);
      if (!target || target === n) continue;
      // C#/Kotlin lists are ambiguous: an interface in `extends` is really implemented.
      if (isInterfaceLike(target) && !isInterfaceLike(n)) n.interfaces.push(target.id);
      else n.parents.push(target.id);
    }
    for (const name of n.info.implements) {
      const target = resolve(n.file, name);
      if (target && target !== n) n.interfaces.push(target.id);
    }
  }

  // Go: implicit interface satisfaction by method names.
  const goInterfaces = nodes.filter((n) => n.lang === "go" && n.info.kind === "interface" && n.info.methods.length > 0);
  if (goInterfaces.length) {
    for (const s of nodes) {
      if (s.lang !== "go" || s.info.kind !== "struct" || s.info.methods.length === 0) continue;
      const names = new Set(s.info.methods.map((m) => m.name));
      for (const i of goInterfaces) {
        if (i.info.methods.every((m) => names.has(m.name)) && !s.interfaces.includes(i.id)) s.interfaces.push(i.id);
      }
    }
  }

  for (const n of nodes) for (const p of [...n.parents, ...n.interfaces]) nodes[p].subs.push(n.id);

  const ancestors = (n: TypeNode): TypeNode[] => {
    const seen = new Set<number>([n.id]);
    const out: TypeNode[] = [];
    const stack = [...n.parents, ...n.interfaces];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(nodes[id]);
      stack.push(...nodes[id].parents, ...nodes[id].interfaces);
    }
    return out;
  };
  const depthMemo = new Map<number, number>();
  const depth = (n: TypeNode, guard = new Set<number>()): number => {
    if (depthMemo.has(n.id)) return depthMemo.get(n.id)!;
    if (guard.has(n.id)) return 0;
    guard.add(n.id);
    const d = n.parents.length ? 1 + Math.max(...n.parents.map((p) => depth(nodes[p], guard))) : 0;
    depthMemo.set(n.id, d);
    return d;
  };

  const inheritEdges: Edge[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    for (const p of [...n.parents, ...n.interfaces]) {
      const to = nodes[p].file;
      const key = `${n.file}>${to}`;
      if (to === n.file || seen.has(key)) continue;
      seen.add(key);
      // Classes declared for type checkers only (`if TYPE_CHECKING:`) never run: their links are lazy.
      inheritEdges.push(n.info.decorators.includes("type-only") ? { from: n.file, to, kind: "inherit", weight: 1, lazy: true } : { from: n.file, to, kind: "inherit", weight: 1 });
    }
  }
  return { model: { nodes, resolve, isInterfaceLike, ancestors, depth }, inheritEdges };
}
