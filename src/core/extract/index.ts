import type { ImportInfo, Lang, SourceInfo } from "../model";
import { complexityOf, countLoc, lineAt, lineStarts, matchBracket, strip } from "../strip";
import { parseBraceFile, type ParsedFile } from "./clike";
import { goImports, parseGo } from "./go";
import { parsePython, pythonImports } from "./python";

/** Keeps only `<script>` contents of Vue/Svelte files (other lines blanked, offsets kept). */
function scriptOnly(source: string): string {
  const out = source.replace(/[^\n]/g, " ").split("");
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].indexOf(">") + 1;
    for (let i = 0; i < m[1].length; i++) out[start + i] = m[1][i];
  }
  return out.join("");
}

function jsImports(code: string, starts: number[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  const at = (offset: number) => lineAt(starts, offset);
  let m: RegExpExecArray | null;
  const from = /\b(import|export)\s+(type\s+)?([\w$*{},\s]*?)\s*from\s*["']([^"']+)["']/g;
  while ((m = from.exec(code))) {
    const clause = m[3];
    const names: string[] = [];
    let alias: string | undefined;
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) alias = ns[1];
    if (clause.includes("*")) names.push("*");
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const part of braces[1].split(",")) {
      const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (local[0]) names.push(local[0].trim());
    }
    const def = /^\s*([\w$]+)\s*(,|$)/.exec(clause);
    if (def && m[1] === "import") names.push("default:" + def[1]);
    out.push({ spec: m[4], names, alias, kind: "module", line: at(m.index) });
  }
  const bare = /\bimport\s*["']([^"']+)["']/g;
  while ((m = bare.exec(code))) out.push({ spec: m[1], names: [], kind: "module", line: at(m.index) });
  const call = /\b(require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = call.exec(code))) out.push({ spec: m[2], names: ["*"], kind: "module", line: at(m.index) });
  return out;
}

function jvmImports(code: string, starts: number[], lang: "java" | "kotlin"): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = lang === "java" ? /^\s*import\s+(static\s+)?([\w.]+)(\.\*)?\s*;/gm : /^\s*import\s+([\w.`]+)(\.\*)?(\s+as\s+(\w+))?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (lang === "java") {
      const spec = m[2];
      const wildcard = !!m[3];
      // `import static a.B.member` → type `a.B`.
      const typeSpec = m[1] && !wildcard ? spec.slice(0, spec.lastIndexOf(".")) : spec;
      out.push({ spec: typeSpec, names: wildcard ? ["*"] : [typeSpec.slice(typeSpec.lastIndexOf(".") + 1)], kind: wildcard && !m[1] ? "namespace" : "type", line: lineAt(starts, m.index) });
    } else {
      const spec = m[1].replace(/`/g, "");
      out.push({ spec, names: m[2] ? ["*"] : [spec.slice(spec.lastIndexOf(".") + 1)], alias: m[4], kind: m[2] ? "namespace" : "type", line: lineAt(starts, m.index) });
    }
  }
  return out;
}

function csharpImports(code: string, starts: number[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*(global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[3]) out.push({ spec: m[4], names: [m[4].slice(m[4].lastIndexOf(".") + 1)], alias: m[3], kind: "type", line: lineAt(starts, m.index) });
    else if (m[2]) out.push({ spec: m[4], names: [m[4].slice(m[4].lastIndexOf(".") + 1)], kind: "type", line: lineAt(starts, m.index) });
    else out.push({ spec: m[4], names: ["*"], kind: "namespace", line: lineAt(starts, m.index) });
  }
  return out;
}

function phpImports(code: string, starts: number[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  const re = /^\s*use\s+(function\s+|const\s+)?([\w\\]+)(\\\{([^}]*)\})?(\s+as\s+(\w+))?\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const base = m[2].replace(/^\\/, "");
    if (m[4]) {
      for (const part of m[4].split(",")) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (name) out.push({ spec: `${base}\\${name.trim()}`, names: [baseName(name)], alias: alias?.trim(), kind: "type", line: lineAt(starts, m.index) });
      }
    } else out.push({ spec: base, names: [baseName(base)], alias: m[6], kind: "type", line: lineAt(starts, m.index) });
  }
  const inc = /\b(require|include)(_once)?\s*\(?\s*(__DIR__\s*\.\s*)?["']([^"']+\.php)["']/g;
  while ((m = inc.exec(code))) out.push({ spec: (m[3] ? "./" : "") + m[4].replace(/^\//, m[3] ? "" : "/"), names: [], kind: "include", line: lineAt(starts, m.index) });
  return out;
}

const baseName = (fqn: string) => fqn.slice(Math.max(fqn.lastIndexOf("\\"), fqn.lastIndexOf(".")) + 1).trim();

/** Namespace lookup for C# (block or file-scoped) and PHP (`namespace X;`). */
function namespaceResolver(masked: string, code: string, lang: Lang): (offset: number) => string | undefined {
  if (lang === "java" || lang === "kotlin") {
    const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1];
    return () => pkg;
  }
  if (lang === "go") {
    const pkg = /^\s*package\s+(\w+)/m.exec(code)?.[1];
    return () => pkg;
  }
  if (lang !== "csharp" && lang !== "php") return () => undefined;
  const ranges: { start: number; end: number; name: string }[] = [];
  const re = lang === "csharp" ? /\bnamespace\s+([\w.]+)\s*(;|\{)/g : /\bnamespace\s+([\w\\]+)\s*(;|\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const brace = m.index + m[0].length - 1;
    const end = m[2] === "{" ? matchBracket(masked, brace) : masked.length;
    ranges.push({ start: m.index, end: end < 0 ? masked.length : end, name: m[1] });
  }
  return (offset) => {
    let best: string | undefined;
    for (const r of ranges) if (offset >= r.start && offset <= r.end) best = best && best.length > r.name.length ? best : r.name;
    return best;
  };
}

const KEYWORDS = new Set(["if", "else", "for", "func", "return", "var", "const", "type", "struct", "interface", "package", "import", "range", "go", "defer", "chan", "map", "switch", "case", "default", "break", "continue", "nil", "true", "false", "select", "fallthrough", "goto", "string", "int", "bool", "error", "byte", "rune", "float64", "int64", "uint", "make", "len", "append", "new", "panic"]);

function collectRefs(masked: string, lang: Lang): { refs: string[]; selectors: string[] } {
  if (lang === "go") {
    const refs = new Set<string>();
    const selectors = new Set<string>();
    for (const m of masked.matchAll(/\b([A-Za-z_]\w*)\.([A-Z]\w*)/g)) selectors.add(`${m[1]}.${m[2]}`);
    for (const m of masked.matchAll(/(?<![.\w])([A-Za-z_]\w*)\b/g)) if (!KEYWORDS.has(m[1])) refs.add(m[1]);
    return { refs: [...refs], selectors: [...selectors] };
  }
  if (lang === "java" || lang === "kotlin" || lang === "csharp" || lang === "php") {
    const refs = new Set<string>();
    for (const m of masked.matchAll(/(?<![\w$])([A-Z][A-Za-z0-9_]*)\b/g)) refs.add(m[1]);
    return { refs: [...refs], selectors: [] };
  }
  return { refs: [], selectors: [] };
}

/** Parses one source file into the language-neutral `SourceInfo`. */
export function extract(source: string, path: string, lang: Lang): SourceInfo {
  let text = source.replace(/\r\n?/g, "\n");
  if (/\.(vue|svelte)$/.test(path)) text = scriptOnly(text);
  if (lang === "php") text = text.replace(/<\?php|<\?=|\?>/g, (s) => " ".repeat(s.length));
  const { code, masked } = strip(text, lang);
  const starts = lineStarts(text);
  const ns = namespaceResolver(masked, code, lang);
  let imports: ImportInfo[] = [];
  let parsed: ParsedFile = { types: [], functions: [], variables: [] };
  switch (lang) {
    case "typescript":
    case "javascript":
      imports = jsImports(code, starts);
      parsed = parseBraceFile(masked, lang, starts, ns);
      break;
    case "java":
    case "kotlin":
      imports = jvmImports(code, starts, lang);
      parsed = parseBraceFile(masked, lang, starts, ns);
      break;
    case "csharp":
      imports = csharpImports(code, starts);
      parsed = parseBraceFile(masked, lang, starts, ns);
      break;
    case "php":
      imports = phpImports(code, starts);
      parsed = parseBraceFile(masked, lang, starts, ns);
      break;
    case "python":
      // Masked text: docstrings often contain example `import` lines.
      imports = pythonImports(masked);
      parsed = parsePython(masked, starts);
      break;
    case "go":
      imports = goImports(code, starts);
      parsed = parseGo(masked, starts);
      break;
    default:
      break;
  }
  if (lang === "go" || lang === "java" || lang === "kotlin") for (const t of parsed.types) t.namespace ??= ns(0);
  const { refs, selectors } = collectRefs(masked, lang);
  return {
    imports,
    types: parsed.types,
    functions: parsed.functions,
    variables: parsed.variables,
    namespace: ns(0),
    refs,
    selectors,
    loc: countLoc(masked),
    lines: starts.length,
    complexity: complexityOf(masked),
  };
}
