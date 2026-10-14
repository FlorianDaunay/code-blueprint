import type { FieldInfo, Lang, MethodInfo, ParamInfo, TypeInfo, TypeKind, Visibility } from "../model";
import { baseTypeName, lineAt, matchBracket, splitTopLevel } from "../strip";

/**
 * Structural parser shared by brace languages (TS/JS, Java, Kotlin, C#, PHP).
 * Works on *masked* text (no comments, blank strings): finds type declarations, splits bodies
 * into members at depth 0 and classifies each member as a method, constructor, property or field.
 */

type BraceLang = Extract<Lang, "typescript" | "javascript" | "java" | "kotlin" | "csharp" | "php">;

interface LangSpec {
  typeKeywords: RegExp;
  /** Statements may end at a newline (no mandatory semicolons). */
  newlineEnds: boolean;
  defaultVisibility: Visibility;
  /** `name: Type` syntax (TS, Kotlin) rather than `Type name`. */
  colonTypes: boolean;
}

const SPECS: Record<BraceLang, LangSpec> = {
  typescript: { typeKeywords: /\b(class|interface|enum)\s+([A-Za-z_$][\w$]*)/g, newlineEnds: true, defaultVisibility: "public", colonTypes: true },
  javascript: { typeKeywords: /\b(class)\s+([A-Za-z_$][\w$]*)/g, newlineEnds: true, defaultVisibility: "public", colonTypes: true },
  java: { typeKeywords: /\b(class|interface|enum|record)\s+([A-Za-z_]\w*)/g, newlineEnds: false, defaultVisibility: "package", colonTypes: false },
  kotlin: { typeKeywords: /\b(class|interface|object)\s+([A-Za-z_]\w*)/g, newlineEnds: true, defaultVisibility: "public", colonTypes: true },
  csharp: { typeKeywords: /\b(class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/g, newlineEnds: false, defaultVisibility: "private", colonTypes: false },
  php: { typeKeywords: /\b(class|interface|trait|enum)\s+([A-Za-z_]\w*)/g, newlineEnds: false, defaultVisibility: "public", colonTypes: false },
};

const MODIFIERS = new Set([
  "public", "private", "protected", "internal", "static", "abstract", "final", "sealed", "open", "readonly",
  "const", "override", "virtual", "synchronized", "async", "export", "default", "declare", "native",
  "transient", "volatile", "partial", "data", "inline", "lateinit", "suspend", "operator", "infix",
  "extern", "unsafe", "new", "event", "required", "strictfp", "fun", "function", "val", "var", "let",
  "get", "set", "init", "companion", "inner", "value", "annotation", "external", "tailrec", "actual", "expect",
]);

/** Words that can never be a member name (other modifiers like `value`, `data`, `inner` can). */
const NOT_NAMES = new Set(["public", "private", "protected", "internal", "static", "abstract", "final", "override", "companion", "fun", "function", "val", "var", "let", "const", "async", "export", "declare"]);

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "foreach", "using", "lock", "fixed", "return", "throw", "when", "synchronized", "try", "else", "do", "new", "typeof", "sizeof", "nameof", "super", "this", "base"]);

const VISIBILITIES: Visibility[] = ["public", "private", "protected", "internal"];

interface RawMember {
  sig: string;
  sigStart: number;
  block?: [number, number];
}

const isAnnotationOnly = (s: string) => /^(\s*(@[\w.]+(\([\s\S]*?\))?|\[[\s\S]*\]|#\[[\s\S]*\]))+\s*$/.test(s);
const CONTINUES_AFTER = /[=,(+\-*/&|?:.<>[]$|\b(extends|implements|where|throws)$|->$/;
const CONTINUES_BEFORE = /^[.?:=&|+\-*/){,<>]/;

/** Splits `masked[from, to)` into member statements at bracket depth 0. */
export function splitMembers(masked: string, from: number, to: number, newlineEnds: boolean): RawMember[] {
  const members: RawMember[] = [];
  let depth = 0;
  let segStart = from;
  const push = (end: number, block?: [number, number]) => {
    const raw = masked.slice(segStart, end);
    const lead = raw.length - raw.trimStart().length;
    const sig = raw.trim();
    if (sig || block) members.push({ sig, sigStart: segStart + lead, block });
  };
  let i = from;
  while (i < to) {
    const ch = masked[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "{") {
      const close = matchBracket(masked, i);
      if (close < 0 || close >= to) break;
      if (depth > 0) {
        i = close + 1;
        continue;
      }
      push(i, [i, close]);
      i = close + 1;
      while (i < to && /[ \t]/.test(masked[i])) i++;
      if (masked[i] === ";" || masked[i] === ",") i++;
      segStart = i;
      continue;
    } else if (ch === "}") {
      break;
    } else if (ch === ";" && depth === 0) {
      push(i);
      segStart = i + 1;
    } else if (ch === "\n" && depth === 0 && newlineEnds) {
      const sig = masked.slice(segStart, i).trim();
      if (!sig) segStart = i + 1;
      else if (!isAnnotationOnly(sig) && !CONTINUES_AFTER.test(sig)) {
        let k = i + 1;
        while (k < to && /\s/.test(masked[k])) k++;
        if (!CONTINUES_BEFORE.test(masked[k] ?? "") && masked[k] !== "{") {
          push(i);
          segStart = i + 1;
        }
      }
    }
    i++;
  }
  if (segStart < to) push(Math.min(i, to));
  return members;
}

/** Index of `ch` at bracket depth 0 in `s`, or -1. */
function indexTopLevel(s: string, chars: string, start = 0): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (depth === 0 && chars.includes(c)) {
      // `=` must be an assignment, not `=>`, `==`, `<=`, `>=`, `!=`.
      if (c === "=" && (s[i + 1] === ">" || s[i + 1] === "=" || "=!<>".includes(s[i - 1] ?? ""))) continue;
      return i;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "<" && /[\w$]/.test(s[i - 1] ?? "")) depth++;
    else if (c === ">" && depth > 0 && s[i - 1] !== "=" && s[i - 1] !== "-") depth--;
  }
  return -1;
}

/** Removes `<...>` generic segments (balanced). */
function dropGenerics(s: string): string {
  let out = "";
  let depth = 0;
  for (const c of s) {
    if (c === "<") depth++;
    else if (c === ">" && depth > 0) depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

interface Decorated {
  rest: string;
  decorators: string[];
}

/** Strips leading `@Annotation(...)`, `[Attribute]`, `#[Attr]` and returns their names. */
function stripDecorators(sig: string): Decorated {
  const decorators: string[] = [];
  let rest = sig;
  for (;;) {
    const m = /^\s*(@([\w.]+)|#\[([\w\\]+)|\[([\w.]+))/.exec(rest);
    if (!m) break;
    const name = m[2] ?? m[3] ?? m[4];
    let end = m[0].length;
    const open = rest.slice(end).search(/\S/);
    if (m[1].startsWith("@") && rest[end + open] === "(") {
      const close = matchBracket(rest, end + open);
      end = close < 0 ? rest.length : close + 1;
    } else if (!m[1].startsWith("@")) {
      const close = matchBracket(rest, rest.indexOf("["));
      end = close < 0 ? rest.length : close + 1;
    }
    decorators.push(baseTypeName(name));
    rest = rest.slice(end);
  }
  return { rest: rest.trim(), decorators };
}

function visibilityOf(words: string[], fallback: Visibility, name: string): Visibility {
  for (const v of VISIBILITIES) if (words.includes(v)) return v;
  if (name.startsWith("#")) return "private";
  return fallback;
}

function parseParams(text: string, lang: BraceLang): { params: ParamInfo[]; promoted: FieldInfo[] } {
  const params: ParamInfo[] = [];
  const promoted: FieldInfo[] = [];
  for (const raw of splitTopLevel(text)) {
    const { rest } = stripDecorators(raw);
    const noDefault = rest.slice(0, indexTopLevel(rest, "=") < 0 ? rest.length : indexTopLevel(rest, "=")).trim();
    let name = "";
    let type: string | undefined;
    const words = noDefault.split(/\s+/);
    if (lang === "typescript" || lang === "javascript" || lang === "kotlin") {
      const colon = indexTopLevel(noDefault, ":");
      const left = colon < 0 ? noDefault : noDefault.slice(0, colon);
      type = colon < 0 ? undefined : noDefault.slice(colon + 1).trim();
      const lw = left.trim().split(/\s+/);
      name = (lw[lw.length - 1] ?? "").replace(/[?.]/g, "");
      const mods = lw.slice(0, -1);
      if (mods.some((w) => ["private", "public", "protected", "readonly", "val", "var", "internal"].includes(w))) {
        promoted.push({ name, type, visibility: visibilityOf(mods, "public", name), isStatic: false, isReadonly: mods.includes("readonly") || mods.includes("val"), flags: ["promoted"], line: 0 });
      }
    } else if (lang === "php") {
      const nameWord = words.find((w) => w.startsWith("$") || w.startsWith("&$") || w.startsWith("...$")) ?? "";
      name = nameWord.replace(/^[&.]*\$/, "");
      const idx = words.indexOf(nameWord);
      const mods = words.slice(0, idx).filter((w) => MODIFIERS.has(w));
      const typeWords = words.slice(0, idx).filter((w) => !MODIFIERS.has(w));
      type = typeWords.join(" ") || undefined;
      if (mods.some((w) => VISIBILITIES.includes(w as Visibility))) {
        promoted.push({ name, type, visibility: visibilityOf(mods, "public", name), isStatic: false, isReadonly: mods.includes("readonly"), flags: ["promoted"], line: 0 });
      }
    } else {
      const cleaned = words.filter((w) => !["final", "ref", "out", "in", "params", "this", "scoped"].includes(w));
      name = cleaned[cleaned.length - 1] ?? "";
      type = cleaned.slice(0, -1).join(" ") || undefined;
      // Java/C# records: `record P(int x)` components are fields — handled by the caller.
    }
    if (name) params.push({ name, type });
  }
  return { params, promoted };
}

export interface MemberContext {
  lang: BraceLang;
  className?: string;
  /** Members of an interface are abstract and public by default. */
  inInterface: boolean;
  /** Kotlin `companion object` members behave as static. */
  forceStatic: boolean;
}

export interface ParsedMembers {
  fields: FieldInfo[];
  methods: MethodInfo[];
}

const BODY_LIMIT = 6000;

/** Classifies the members of a body (class body or file top level). */
export function parseMembers(masked: string, from: number, to: number, ctx: MemberContext, starts: number[]): ParsedMembers {
  const spec = SPECS[ctx.lang];
  const out: ParsedMembers = { fields: [], methods: [] };
  for (const member of splitMembers(masked, from, to, spec.newlineEnds)) {
    classify(member, masked, ctx, starts, out);
  }
  return out;
}

const TYPE_DECL = /(^|\s)(class|interface|enum|struct|record|trait|namespace|module|package|import|using|use|require|object|typealias|type)\s/;

function classify(member: RawMember, masked: string, ctx: MemberContext, starts: number[], out: ParsedMembers) {
  const spec = SPECS[ctx.lang];
  const { rest: sig0, decorators } = stripDecorators(member.sig);
  let sig = sig0;
  const line = lineAt(starts, member.sigStart);
  const blockText = member.block ? masked.slice(member.block[0] + 1, member.block[1]) : "";
  const blockLoc = member.block ? lineAt(starts, member.block[1]) - line + 1 : 1;

  if (!sig) return; // initializer blocks, stray braces
  // Kotlin companion object: its members are the class's statics.
  if (/^companion\s+object\b/.test(sig) && member.block) {
    const inner = parseMembers(masked, member.block[0] + 1, member.block[1], { ...ctx, forceStatic: true }, starts);
    out.fields.push(...inner.fields);
    out.methods.push(...inner.methods);
    return;
  }
  if (/^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(public\s+|private\s+|internal\s+|protected\s+)?(static\s+)?(final\s+|sealed\s+|open\s+|data\s+|partial\s+|readonly\s+)*(class|interface|enum|struct|record|trait|namespace|object|module)\b/.test(sig)) return;
  if (/^(import|export\s*\{|export\s+\*|package|using|use|require|namespace|typealias|type\s+\w+\s*=|init$|static$|\w+\s*:$)/.test(sig)) return;
  if (TYPE_DECL.test(" " + sig.split("(")[0] + " ") && !/=/.test(sig.split("(")[0])) {
    // `export default class`, `sealed interface` and similar declarations handled by findTypes.
    if (/\b(class|interface|enum|struct|record|trait|object)\b/.test(sig.split("(")[0])) return;
  }

  const paren = indexTopLevel(sig, "(");
  const assign = indexTopLevel(sig, "=");
  const colonBeforeParen = spec.colonTypes && paren >= 0 && indexTopLevel(sig.slice(0, paren), ":") >= 0 && !/\bfun\b|\bconstructor\b/.test(sig.slice(0, paren));
  const isArrowField = assign >= 0 && (paren < 0 || assign < paren) && /^\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*(:\s*[^=]+)?=>/.test(sig.slice(assign + 1)) ;
  const isFunctionExpr = assign >= 0 && (paren < 0 || assign < paren) && /^\s*(async\s+)?function\b/.test(sig.slice(assign + 1));

  // C# property with accessors `Type Name { get; set; }` / `{ get { ... } }`.
  if (ctx.lang === "csharp" && member.block && paren < 0 && /\b(get|set|init)\b/.test(blockText) && !sig.includes("=")) {
    const words = sig.split(/\s+/);
    const name = words[words.length - 1];
    const mods = words.filter((w) => MODIFIERS.has(w));
    const type = words.filter((w) => !MODIFIERS.has(w)).slice(0, -1).join(" ");
    const getterBody = /\bget\s*(\{|=>)/.exec(blockText);
    const isStatic = mods.includes("static") || ctx.forceStatic;
    const visibility = visibilityOf(mods, ctx.inInterface ? "public" : spec.defaultVisibility, name);
    if (getterBody) {
      out.methods.push({ name, kind: "getter", params: [], returns: type, visibility, isStatic, isAbstract: false, flags: mods, body: blockText.slice(0, BODY_LIMIT), line, loc: blockLoc });
    }
    const hasSetter = /\bset\b/.test(blockText);
    const privateSetter = /\b(private|protected)\s+set\b/.test(blockText);
    out.fields.push({ name, type, visibility, isStatic, isReadonly: !hasSetter || privateSetter, flags: ["property", ...(hasSetter && !privateSetter ? ["setter"] : []), ...mods], line });
    return;
  }
  // C# expression-bodied property `Type Name => expr`.
  if (ctx.lang === "csharp" && paren < 0 && /=>/.test(sig) && !member.block) {
    const arrow = sig.indexOf("=>");
    const words = sig.slice(0, arrow).trim().split(/\s+/);
    const name = words[words.length - 1];
    const mods = words.filter((w) => MODIFIERS.has(w));
    out.methods.push({
      name, kind: "getter", params: [], returns: words.filter((w) => !MODIFIERS.has(w)).slice(0, -1).join(" "),
      visibility: visibilityOf(mods, spec.defaultVisibility, name), isStatic: mods.includes("static") || ctx.forceStatic,
      isAbstract: false, flags: mods, body: sig.slice(arrow + 2).slice(0, BODY_LIMIT), line, loc: 1,
    });
    return;
  }

  const isMethod = (paren >= 0 && (assign < 0 || paren < assign) && !colonBeforeParen) || isArrowField || isFunctionExpr;
  if (isMethod) {
    let pre: string;
    let paramsText: string;
    let after: string;
    let body = blockText;
    if (isArrowField || isFunctionExpr) {
      pre = sig.slice(0, assign);
      const rhs = sig.slice(assign + 1);
      const p = rhs.indexOf("(");
      const close = p >= 0 ? matchBracket(rhs, p) : -1;
      paramsText = p >= 0 && close > p ? rhs.slice(p + 1, close) : rhs.split("=>")[0];
      after = close > p ? rhs.slice(close + 1) : "";
      if (!member.block) body = rhs.slice(rhs.indexOf("=>") + 2);
    } else {
      const close = matchBracket(sig, paren);
      pre = sig.slice(0, paren);
      paramsText = close < 0 ? "" : sig.slice(paren + 1, close);
      after = close < 0 ? "" : sig.slice(close + 1);
      // Kotlin / C# expression bodies without a block.
      if (!member.block) {
        const eq = indexTopLevel(after, "=");
        const arrow = after.indexOf("=>");
        if (arrow >= 0) body = after.slice(arrow + 2);
        else if (eq >= 0) body = after.slice(eq + 1);
      }
    }
    const words = dropGenerics(pre).trim().split(/\s+/).filter(Boolean);
    let name = (words[words.length - 1] ?? "").replace(/[?!:]$/, "");
    if (!name || CONTROL.has(name)) return;
    if (name.includes(".")) name = name.slice(name.lastIndexOf(".") + 1); // Kotlin extension `fun Foo.bar()`
    const mods = words.slice(0, -1).filter((w) => MODIFIERS.has(w));
    let kind: MethodInfo["kind"] = "method";
    if (name === "constructor" || name === "__construct" || (ctx.className && name === ctx.className && ctx.lang !== "kotlin" && ctx.lang !== "php")) kind = "ctor";
    if (ctx.lang === "kotlin" && name === "constructor") kind = "ctor";
    if (words.includes("get") && words.indexOf("get") === words.length - 2) kind = "getter";
    if (words.includes("set") && words.indexOf("set") === words.length - 2) kind = "setter";
    const nonMods = words.slice(0, -1).filter((w) => !MODIFIERS.has(w));
    let returns: string | undefined;
    if (spec.colonTypes || ctx.lang === "php") {
      const m = /^\s*:\s*([^{=;]+?)\s*(=>|=|\{|$|where\b)/.exec(after);
      returns = m?.[1]?.trim();
    } else {
      returns = nonMods.join(" ") || undefined;
    }
    const { params, promoted } = parseParams(paramsText, ctx.lang);
    if (kind === "ctor") for (const f of promoted) out.fields.push({ ...f, line });
    const isStatic = mods.includes("static") || ctx.forceStatic;
    const isAbstract = mods.includes("abstract") || (ctx.inInterface && !member.block && !/=>|=/.test(after) && !mods.includes("default") && !isStatic);
    const visibility = visibilityOf(mods, ctx.inInterface ? "public" : spec.defaultVisibility, name);
    out.methods.push({
      name: name.replace(/^#/, ""), kind, params, returns, visibility, isStatic, isAbstract,
      flags: [...mods.filter((m) => !VISIBILITIES.includes(m as Visibility)), ...decorators.map((d) => "@" + d)],
      body: body.slice(0, BODY_LIMIT), line, loc: blockLoc,
    });
    return;
  }

  // Field / property / variable.
  const left = assign >= 0 ? sig.slice(0, assign) : sig;
  let init = assign >= 0 ? sig.slice(assign + 1).trim() : undefined;
  const byIdx = ctx.lang === "kotlin" ? left.search(/\sby\s/) : -1;
  const decl = byIdx >= 0 ? left.slice(0, byIdx) : left;
  if (byIdx >= 0) init = left.slice(byIdx + 4).trim();
  if (member.block) init = (init ?? "") + " {" + blockText.slice(0, 400) + "}";
  let name: string;
  let type: string | undefined;
  let mods: string[];
  if (spec.colonTypes) {
    const colon = indexTopLevel(decl, ":");
    const head = (colon < 0 ? decl : decl.slice(0, colon)).trim().split(/\s+/);
    name = (head[head.length - 1] ?? "").replace(/[?!]$/, "");
    type = colon < 0 ? undefined : decl.slice(colon + 1).trim();
    mods = head.slice(0, -1);
  } else {
    // Several declarators `int a, b;` → keep the first.
    const first = splitTopLevel(decl)[0] ?? decl;
    const words = dropGenerics(first).trim().split(/\s+/).filter(Boolean);
    const fullWords = first.trim().split(/\s+(?![^<]*>)/).filter(Boolean);
    name = words[words.length - 1] ?? "";
    mods = words.slice(0, -1).filter((w) => MODIFIERS.has(w));
    type = fullWords.slice(0, -1).filter((w) => !MODIFIERS.has(w)).join(" ") || undefined;
  }
  const hashPrivate = name.startsWith("#");
  name = name.replace(/^\$/, "").replace(/^#/, "");
  if (!/^[A-Za-z_$][\w$]*$/.test(name) || CONTROL.has(name) || NOT_NAMES.has(name)) return;
  const isStatic = mods.includes("static") || mods.includes("const") || ctx.forceStatic || (ctx.lang === "php" && mods.includes("const"));
  out.fields.push({
    name, type, visibility: hashPrivate ? "private" : visibilityOf(mods, spec.defaultVisibility, name), isStatic,
    isReadonly: mods.some((m) => m === "readonly" || m === "final" || m === "val" || m === "const"),
    flags: [...mods.filter((m) => !VISIBILITIES.includes(m as Visibility)), ...decorators.map((d) => "@" + d)],
    init: init?.slice(0, 600), line,
  });
}

/** Finds the statement boundary before `index` and returns the words/decorators preceding a declaration. */
function prefixOf(masked: string, index: number): string {
  let k = index - 1;
  let depth = 0;
  while (k >= 0) {
    const c = masked[k];
    if (c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") depth--;
    else if (depth === 0 && (c === ";" || c === "{" || c === "}")) break;
    k--;
  }
  return masked.slice(k + 1, index);
}

export interface ParsedFile {
  types: TypeInfo[];
  functions: MethodInfo[];
  variables: FieldInfo[];
}

/** Ranges `[start, end]` of namespaced blocks: C# `namespace X {}` or PHP `namespace X;`. */
export type NamespaceAt = (offset: number) => string | undefined;

export function parseBraceFile(masked: string, lang: BraceLang, starts: number[], namespaceAt: NamespaceAt): ParsedFile {
  const spec = SPECS[lang];
  const types: TypeInfo[] = [];
  const typeRanges: [number, number][] = [];
  spec.typeKeywords.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = spec.typeKeywords.exec(masked))) {
    const keyword = m[1];
    const name = m[2];
    const start = m.index;
    const before = masked[start - 1] ?? " ";
    if (before === "." || before === "$" || /\w/.test(before)) continue;
    if (keyword === "object" && /companion\s+$/.test(masked.slice(Math.max(0, start - 12), start))) continue;
    const prefix = prefixOf(masked, start);
    if (/=\s*$|\breturn\s*$|\(\s*$|\bnew\s*$/.test(prefix)) {
      // `const Foo = class {...}` still declares a class; `new class {}` does not.
      if (!/=\s*$/.test(prefix)) continue;
    }
    if (lang === "csharp" && keyword === "record" && /^\s*(struct|class)\b/.test(masked.slice(start + 6))) continue;
    const { decorators, rest: modText } = stripDecorators(prefix.trim());
    const mods = modText.split(/\s+/).filter(Boolean);

    // Header: up to `{`, `;` or (Kotlin) end of line without continuation.
    let k = start + m[0].length;
    let depth = 0;
    let bodyOpen = -1;
    let headerEnd = masked.length;
    for (; k < masked.length; k++) {
      const c = masked[k];
      if (c === "(" || c === "<" || c === "[") depth++;
      else if (c === ")" || c === "]" || (c === ">" && masked[k - 1] !== "=" && masked[k - 1] !== "-")) depth = Math.max(0, depth - 1);
      else if (depth === 0 && c === "{") {
        bodyOpen = k;
        headerEnd = k;
        break;
      } else if (depth === 0 && (c === ";" || c === "}")) {
        headerEnd = k;
        break;
      } else if (depth === 0 && c === "\n" && spec.newlineEnds) {
        const sofar = masked.slice(start, k).trimEnd();
        let j = k + 1;
        while (j < masked.length && /\s/.test(masked[j])) j++;
        if (!/[,:]$/.test(sofar) && !/^[{:,]|^where\b/.test(masked.slice(j, j + 6))) {
          headerEnd = k;
          break;
        }
      }
    }
    const header = masked.slice(start + m[0].length, headerEnd);
    const bodyClose = bodyOpen >= 0 ? matchBracket(masked, bodyOpen) : -1;
    const kindWord = keyword === "@interface" ? "interface" : keyword;
    let kind: TypeKind = kindWord as TypeKind;
    if (lang === "kotlin" && mods.includes("enum")) kind = "enum";
    const isInterface = kind === "interface" || kind === "trait";

    // Supertypes.
    const ext: string[] = [];
    const impl: string[] = [];
    let primaryCtor: string | undefined;
    let primaryCtorMods: string[] = [];
    let h = header.replace(/^\s*<[\s\S]*?>(?=\s*[({:]|\s+(extends|implements|where)|\s*$)/, "");
    if (lang === "kotlin" || lang === "java" || lang === "csharp") {
      const ctorMatch = /^\s*((?:(?:private|protected|internal|public)\s+)?(?:@\w+\s+)*(?:constructor)?)\s*\(/.exec(h);
      if (ctorMatch) {
        const open = h.indexOf("(", ctorMatch.index);
        const close = matchBracket(h, open);
        primaryCtor = h.slice(open + 1, close);
        primaryCtorMods = ctorMatch[1].trim().split(/\s+/).filter(Boolean);
        h = h.slice(close + 1);
      }
    }
    const takeList = (text: string) => splitTopLevel(text).map((t) => t.replace(/\(.*$/s, "").trim()).filter(Boolean);
    const extM = /\bextends\s+([\s\S]+?)(?=\bimplements\b|\bwhere\b|$)/.exec(h);
    const implM = /\bimplements\s+([\s\S]+?)(?=\bextends\b|\bwhere\b|$)/.exec(h);
    if (extM) (isInterface ? impl : ext).push(...takeList(extM[1]).map(baseTypeName));
    if (implM) impl.push(...takeList(implM[1]).map(baseTypeName));
    if ((lang === "kotlin" || lang === "csharp") && /^\s*:/.test(h)) {
      const list = h.replace(/^\s*:/, "").replace(/\bwhere\b[\s\S]*$/, "");
      for (const item of splitTopLevel(list)) {
        const n = baseTypeName(item.replace(/\(.*$/s, "").replace(/\bby\b[\s\S]*$/, ""));
        if (!n) continue;
        // Kotlin: `Base()` (constructor call) is a class, bare names are interfaces.
        // C#: first item is the base class unless it looks like an interface (`IThing`).
        if (lang === "kotlin") (/\(/.test(item) ? ext : impl).push(n);
        else if (ext.length === 0 && impl.length === 0 && !/^I[A-Z]/.test(n) && !isInterface) ext.push(n);
        else impl.push(n);
      }
    }

    const ctx: MemberContext = { lang, className: name, inInterface: isInterface, forceStatic: false };
    const members = bodyOpen >= 0 && bodyClose > bodyOpen ? parseMembers(masked, bodyOpen + 1, bodyClose, ctx, starts) : { fields: [], methods: [] };
    const line = lineAt(starts, start);
    if (primaryCtor !== undefined) {
      const { params, promoted } = parseParams(primaryCtor, lang === "kotlin" ? "kotlin" : lang);
      members.methods.unshift({
        name: "constructor", kind: "ctor", params, visibility: visibilityOf(primaryCtorMods, "public", name),
        isStatic: false, isAbstract: false, flags: ["primary"], body: "", line, loc: 1,
      });
      if (lang === "kotlin" || (lang as string) === "java" || lang === "csharp") {
        // Kotlin `val/var` params; Java/C# record components are properties.
        const fields = lang === "kotlin" ? promoted : params.map((p) => ({ name: p.name, type: p.type, visibility: "public" as Visibility, isStatic: false, isReadonly: true, flags: ["promoted"], line: 0 }));
        for (const f of fields) members.fields.push({ ...f, line });
      }
    }
    const isAbstract = mods.includes("abstract") || isInterface;
    let isFinal = mods.includes("final") || mods.includes("sealed") || (lang === "csharp" && mods.includes("static"));
    if (lang === "kotlin") isFinal = !mods.includes("open") && !mods.includes("abstract") && !isInterface && !mods.includes("sealed");
    if (kind === "object" || kind === "enum" || kind === "record") isFinal = true;
    types.push({
      name, kind, isAbstract, isFinal,
      isExported: mods.includes("export") || mods.includes("public") || lang === "kotlin" || lang === "php" || lang === "java" && !mods.includes("private"),
      extends: [...new Set(ext)], implements: [...new Set(impl)],
      fields: members.fields, methods: members.methods,
      namespace: namespaceAt(start),
      decorators: [...decorators, ...mods.filter((w) => w === "data" || w === "sealed" || w === "partial")],
      line, endLine: bodyClose >= 0 ? lineAt(starts, bodyClose) : line,
    });
    typeRanges.push([start, bodyClose >= 0 ? bodyClose : headerEnd]);
  }

  // Top-level functions and variables (outside every type).
  const functions: MethodInfo[] = [];
  const variables: FieldInfo[] = [];
  if (lang === "typescript" || lang === "javascript" || lang === "kotlin" || lang === "php") {
    const top = parseMembers(masked, 0, masked.length, { lang, inInterface: false, forceStatic: false }, starts);
    const outside = (line: number) => !types.some((t) => line >= t.line && line <= t.endLine);
    functions.push(...top.methods.filter((f) => outside(f.line) && f.kind !== "ctor"));
    variables.push(...top.fields.filter((v) => outside(v.line)));
  }
  return { types, functions, variables };
}
