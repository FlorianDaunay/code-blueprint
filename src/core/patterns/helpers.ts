import type { AnalysisContext } from "../analyze";
import type { FieldInfo, Lang, MethodInfo, PatternCheck, PatternMatch, PatternVerdict } from "../model";
import { parseTypeExpr, type TypeNode } from "../types";

export interface PatternContext extends AnalysisContext {
  /** Type name → files that instantiate it (`new X(`, `X(` in Kotlin/Python, `&X{` in Go). */
  creations: Map<string, Set<number>>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names of types a body instantiates. */
export function createdTypes(body: string, lang: Lang): Set<string> {
  const out = new Set<string>();
  const add = (re: RegExp) => {
    for (const m of body.matchAll(re)) out.add(m[1]);
  };
  add(/\bnew\s+([A-Z_a-z][\w$]*)\s*[(<{]/g);
  if (lang === "kotlin" || lang === "python") add(/(?<![\w.$])([A-Z][\w]*)\s*\(/g);
  if (lang === "go") add(/&?([A-Z]\w*)\s*\{/g);
  if (lang === "php") add(/\bnew\s+(static|self)\b/g);
  return out;
}

export function buildCreations(ctx: AnalysisContext): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const f of ctx.files) {
    if (!f.source) continue;
    const bodies = [...f.source.types.flatMap((t) => [...t.methods.map((m) => m.body), ...t.fields.map((x) => x.init ?? "")]), ...f.source.functions.map((m) => m.body), ...f.source.variables.map((v) => v.init ?? "")];
    for (const body of bodies) {
      for (const name of createdTypes(body, f.lang)) {
        const s = map.get(name) ?? new Set<number>();
        s.add(f.id);
        map.set(name, s);
      }
    }
  }
  return map;
}

export const ctors = (t: TypeNode) => t.info.methods.filter((m) => m.kind === "ctor" || m.name === "__new__");
export const methods = (t: TypeNode) => t.info.methods.filter((m) => m.kind !== "ctor" && m.name !== "__new__" && m.name !== "__init__");
export const publicMethods = (t: TypeNode) => methods(t).filter((m) => m.visibility === "public" || m.visibility === "internal");

/** True when every way to construct the type from outside is closed. */
export function constructorIsHidden(t: TypeNode): boolean {
  if (t.info.kind === "object") return true;
  const list = t.info.methods.filter((m) => m.kind === "ctor");
  if (t.lang === "python") return t.info.methods.some((m) => m.name === "__new__") || t.info.decorators.some((d) => /^metaclass:.*singleton/i.test(d));
  if (t.lang === "go") return !t.info.isExported;
  return list.length > 0 && list.every((c) => c.visibility === "private" || c.visibility === "protected");
}

export function isOwnType(t: TypeNode, type: string | undefined): boolean {
  const parsed = parseTypeExpr(type);
  if (!parsed) return false;
  return parsed.elem === t.info.name || ["static", "self", "Self"].includes(parsed.elem);
}

export const bodyCalls = (body: string, name: string) => new RegExp(`(^|[^\\w$])${escape(name)}\\s*\\(`).test(body);
export const bodyMentions = (body: string, name: string) => new RegExp(`(^|[^\\w$])${escape(name)}([^\\w$]|$)`).test(body);
export const bodyCreates = (body: string, name: string, lang: Lang) => createdTypes(body, lang).has(name);

/** `this.x.foo(` / `self.x.foo(` / `$this->x->foo(` / `x.foo(` → set of method names called on field `x`. */
export function callsOnField(body: string, field: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`(?:this\\.|self\\.|\\$this->|[^\\w$.]|^)${escape(field)}\\s*(?:\\?\\.|\\.|->|!!\\.)\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
  for (const m of body.matchAll(re)) out.add(m[1]);
  return out;
}

export function returnsSelf(m: MethodInfo, t: TypeNode): boolean {
  if (isOwnType(t, m.returns) || m.returns === "this") return true;
  const b = m.body.trim();
  return /\breturn\s+(this|self|\$this)\s*;?\s*$/.test(b) || /^\s*(this|self)\s*$/.test(b) || /\bapply\s*$/.test(b) || /^\s*apply\s*\{/.test(b);
}

export const isCollectionField = (f: FieldInfo) => parseTypeExpr(f.type)?.isCollection === true || /^\s*(\[\s*\]|new\s+(ArrayList|List|HashSet|Set|LinkedList|Array|Map|CopyOnWriteArrayList)|mutableListOf|arrayListOf|mutableSetOf|list\(\)|set\(\)|\[\]|\{\}|array\(\)|make\(\[\])/.test(f.init ?? "");
export const elemType = (f: FieldInfo) => parseTypeExpr(f.type)?.elem;

export function check(kind: PatternCheck["kind"], ok: boolean, label: string, hint?: string): PatternCheck {
  return { kind, ok, label, hint };
}

const ref = (t: TypeNode) => ({ file: t.file, name: t.info.name, line: t.info.line });

export function makeMatch(
  _ctx: AnalysisContext,
  pattern: string,
  key: string,
  roles: Record<string, TypeNode[]>,
  checks: PatternCheck[],
  confidence: number,
  summary: string,
): PatternMatch {
  const applicable = checks;
  const failedRequired = applicable.some((c) => c.kind === "required" && !c.ok);
  const antiPresent = applicable.some((c) => c.kind === "anti" && !c.ok);
  const missingRecommended = applicable.some((c) => c.kind === "recommended" && !c.ok);
  const verdict: PatternVerdict = failedRequired || antiPresent ? "flawed" : missingRecommended ? "partial" : "complete";
  const score = applicable.length ? applicable.filter((c) => c.ok).length / applicable.length : 1;
  const roleList = Object.entries(roles)
    .filter(([, types]) => types.length)
    .map(([role, types]) => ({ role, types: dedupe(types).map(ref) }));
  const files = [...new Set(roleList.flatMap((r) => r.types.map((t) => t.file)))];
  return { id: `${pattern}:${key}`, pattern, verdict, score, confidence: Math.min(1, confidence), roles: roleList, files, checks, summary };
}

const dedupe = (types: TypeNode[]) => [...new Map(types.map((t) => [t.id, t])).values()];

/** Concrete (non-abstract, non-interface) transitive implementations of a type. */
export function concreteSubs(ctx: PatternContext, t: TypeNode): TypeNode[] {
  const out: TypeNode[] = [];
  const seen = new Set<number>([t.id]);
  const stack = [...t.subs];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = ctx.types.nodes[id];
    if (!n.info.isAbstract && !ctx.types.isInterfaceLike(n)) out.push(n);
    stack.push(...n.subs);
  }
  return out;
}

export const isAbstraction = (ctx: PatternContext, t: TypeNode | undefined) => !!t && (t.info.isAbstract || ctx.types.isInterfaceLike(t));

export const nameHas = (t: TypeNode, re: RegExp) => re.test(t.info.name);

/** All method bodies of a type joined, for coarse checks. */
export const allBodies = (t: TypeNode) => t.info.methods.map((m) => m.body).join("\n");

export const TYPE_CHECK = (name: string) => new RegExp(`\\b(instanceof|is|as)\\s+${escape(name)}\\b|isinstance\\([^)]*,\\s*${escape(name)}\\)|case\\s+${escape(name)}\\b|\\.\\s*type\\s*==`);
