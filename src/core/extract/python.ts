import type { FieldInfo, ImportInfo, MethodInfo, ParamInfo, TypeInfo, Visibility } from "../model";
import { baseTypeName, lineAt, matchBracket, splitTopLevel } from "../strip";
import type { ParsedFile } from "./clike";

const BODY_LIMIT = 6000;

function visibility(name: string): Visibility {
  if (name.startsWith("__") && !name.endsWith("__")) return "private";
  if (name.startsWith("_") && !name.endsWith("__")) return "protected";
  return "public";
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Joins physical lines into logical lines (open brackets, backslash continuations). */
function logicalLines(code: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const lines = code.split("\n");
  let buffer = "";
  let start = 0;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!buffer) start = i + 1;
    buffer += (buffer ? " " : "") + l;
    for (const c of l) {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && !l.trimEnd().endsWith("\\")) {
      out.push({ text: buffer.replace(/\\\s*$/, ""), line: start });
      buffer = "";
    }
  }
  if (buffer) out.push({ text: buffer, line: start });
  return out;
}

export function pythonImports(code: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  // Imports under `if TYPE_CHECKING:` exist only for type hints: they are the idiom to *avoid* runtime cycles.
  let typeOnlyIndent = -1;
  // Indent of the innermost enclosing `def`, to spot function-local (lazy) imports.
  const defs: number[] = [];
  for (const { text, line } of logicalLines(code)) {
    const t = text.trim();
    if (!t) continue;
    const indent = text.length - text.trimStart().length;
    while (defs.length && indent <= defs[defs.length - 1]) defs.pop();
    if (/^(async\s+)?def\s/.test(t)) defs.push(indent);
    const lazy = defs.length > 0 && indent > defs[defs.length - 1];
    if (typeOnlyIndent >= 0) {
      if (indent > typeOnlyIndent) continue;
      typeOnlyIndent = -1;
    }
    if (/^if\s+(not\s+)?([\w.]+\.)?TYPE_CHECKING\s*:/.test(t)) {
      if (!/\bnot\b/.test(t)) typeOnlyIndent = indent;
      continue;
    }
    let m = /^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(t);
    if (m) {
      const names = m[3].replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      imports.push({ spec: m[2], names, level: m[1].length, kind: "module", line, ...(lazy ? { lazy } : {}) });
      continue;
    }
    m = /^import\s+(.+)$/.exec(t);
    if (m) {
      for (const part of m[1].split(",")) {
        const [spec, alias] = part.trim().split(/\s+as\s+/);
        if (spec) imports.push({ spec: spec.trim(), names: ["*"], alias: alias?.trim(), level: 0, kind: "module", line, ...(lazy ? { lazy } : {}) });
      }
    }
  }
  return imports;
}

function parseParams(text: string): ParamInfo[] {
  return splitTopLevel(text)
    .map((p) => {
      const noDefault = p.split("=")[0];
      const [name, type] = noDefault.split(":").map((s) => s.trim());
      return { name: name.replace(/^\*+/, ""), type: type || undefined };
    })
    .filter((p) => p.name && p.name !== "/" && p.name !== "");
}

/** End line index (exclusive) of the block opened by the line at `start` with indent `indent`. */
function blockEnd(lines: string[], start: number, indent: number): number {
  let i = start + 1;
  let last = start;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indentOf(l) <= indent) break;
    last = i;
  }
  return last + 1;
}

function decoratorsAbove(lines: string[], index: number, indent: number): string[] {
  const out: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indentOf(l) !== indent || !l.trim().startsWith("@")) break;
    out.unshift(baseTypeName(l.trim().slice(1).split("(")[0]));
  }
  return out;
}

function parseDef(masked: string, starts: number[], lines: string[], i: number, match: RegExpExecArray): MethodInfo | null {
  const indent = match[1].length;
  const name = match[3];
  const lineOffset = starts[i];
  const open = masked.indexOf("(", lineOffset + match[0].length - 1);
  const close = open >= 0 ? matchBracket(masked, open) : -1;
  if (close < 0) return null;
  const params = parseParams(masked.slice(open + 1, close)).filter((p, k) => !(k === 0 && (p.name === "self" || p.name === "cls")));
  const afterSig = masked.slice(close + 1, masked.indexOf(":", close + 1) >= 0 ? masked.indexOf("\n", close) : close + 1);
  const ret = /->\s*([^:]+):/.exec(afterSig)?.[1]?.trim();
  const sigEndLine = lineAt(starts, close) - 1;
  const end = blockEnd(lines, sigEndLine, indent);
  const decorators = decoratorsAbove(lines, i, indent);
  const body = lines.slice(sigEndLine + 1, end).join("\n");
  const isStatic = decorators.includes("staticmethod") || decorators.includes("classmethod");
  let kind: MethodInfo["kind"] = name === "__init__" ? "ctor" : "method";
  if (decorators.includes("property")) kind = "getter";
  if (decorators.some((d) => d === "setter")) kind = "setter";
  return {
    name, kind, params, returns: ret, visibility: visibility(name), isStatic,
    isAbstract: decorators.includes("abstractmethod") || /^\s*(\.\.\.|pass|raise\s+NotImplementedError)\s*$/.test(body.trim().split("\n").filter(Boolean).join(" ")),
    flags: decorators.map((d) => "@" + d).concat(match[2] ? ["async"] : []),
    body: body.slice(0, BODY_LIMIT), line: i + 1, loc: end - i,
  };
}

const ASSIGN = /^([ \t]*)([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(.+)$|^([ \t]*)([A-Za-z_]\w*)\s*:\s*([^=]+)$/;

export function parsePython(masked: string, starts: number[]): ParsedFile {
  const lines = masked.split("\n");
  const types: TypeInfo[] = [];
  const functions: MethodInfo[] = [];
  const variables: FieldInfo[] = [];
  const classRe = /^([ \t]*)class\s+(\w+)\s*(\(|:)/;
  const defRe = /^([ \t]*)(async\s+)?def\s+(\w+)\s*\(/;

  // Lines inside `if TYPE_CHECKING:` blocks: declarations there exist for type checkers only.
  const typeOnly = new Set<number>();
  lines.forEach((l, i) => {
    if (!/^\s*if\s+([\w.]+\.)?TYPE_CHECKING\s*:/.test(l)) return;
    const end = blockEnd(lines, i, indentOf(l));
    for (let k = i + 1; k < end; k++) typeOnly.add(k);
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cm = classRe.exec(line);
    if (cm) {
      const indent = cm[1].length;
      let bases: string[] = [];
      let headerEndLine = i;
      if (cm[3] === "(") {
        const open = starts[i] + line.indexOf("(");
        const close = matchBracket(masked, open);
        if (close > 0) {
          bases = splitTopLevel(masked.slice(open + 1, close));
          headerEndLine = lineAt(starts, close) - 1;
        }
      }
      const end = blockEnd(lines, headerEndLine, indent);
      const meta = bases.find((b) => b.startsWith("metaclass"));
      const superNames = bases.filter((b) => !b.includes("=")).map(baseTypeName).filter((b) => b && b !== "object");
      const decorators = decoratorsAbove(lines, i, indent);
      if (typeOnly.has(i)) decorators.push("type-only");
      if (meta) decorators.push("metaclass:" + baseTypeName(meta.split("=")[1] ?? ""));
      const fields: FieldInfo[] = [];
      const methods: MethodInfo[] = [];
      // Member indent = indent of first non-blank body line.
      let memberIndent = -1;
      for (let j = headerEndLine + 1; j < end; j++) {
        if (lines[j].trim()) {
          memberIndent = indentOf(lines[j]);
          break;
        }
      }
      for (let j = headerEndLine + 1; j < end; j++) {
        const l = lines[j];
        if (!l.trim() || indentOf(l) !== memberIndent) continue;
        const dm = defRe.exec(l);
        if (dm) {
          const method = parseDef(masked, starts, lines, j, dm);
          if (method) methods.push(method);
          continue;
        }
        const am = ASSIGN.exec(l);
        if (am && !/^\s*(return|if|for|while|with|pass|raise|elif|else|try|except|import|from)\b/.test(l)) {
          const name = am[2] ?? am[6];
          fields.push({ name, type: (am[3] ?? am[7])?.trim(), visibility: visibility(name), isStatic: true, isReadonly: /^[A-Z_0-9]+$/.test(name), flags: ["class-attr"], init: am[4]?.trim().slice(0, 600), line: j + 1 });
        }
      }
      // Instance attributes assigned through `self.x = ...` anywhere in methods.
      const seen = new Set(fields.map((f) => f.name));
      for (const method of methods) {
        const re = /\bself\.([A-Za-z_]\w*)\s*(?::\s*([^=\n]+))?=(?!=)\s*([^\n]*)/g;
        let am: RegExpExecArray | null;
        while ((am = re.exec(method.body))) {
          if (seen.has(am[1])) continue;
          seen.add(am[1]);
          fields.push({ name: am[1], type: am[2]?.trim(), visibility: visibility(am[1]), isStatic: false, isReadonly: false, flags: method.kind === "ctor" ? ["instance"] : ["instance", "late"], init: am[3].trim().slice(0, 600), line: method.line });
        }
      }
      const isProtocol = superNames.includes("Protocol");
      const isAbc = superNames.includes("ABC") || meta?.includes("ABCMeta") === true || methods.some((m) => m.isAbstract && m.flags.includes("@abstractmethod"));
      const allAbstract = methods.length > 0 && methods.filter((m) => m.kind !== "ctor").every((m) => m.isAbstract);
      types.push({
        name: cm[2],
        kind: isProtocol || (isAbc && allAbstract) ? "interface" : "class",
        isAbstract: isProtocol || isAbc,
        isFinal: decorators.includes("final"),
        isExported: !cm[2].startsWith("_"),
        extends: superNames.filter((n) => n !== "ABC" && n !== "Protocol" && n !== "Generic"),
        implements: [],
        fields, methods, decorators,
        line: i + 1, endLine: end,
      });
      continue;
    }
    if (indentOf(line) === 0) {
      const dm = defRe.exec(line);
      if (dm) {
        const fn = parseDef(masked, starts, lines, i, dm);
        if (fn) functions.push(fn);
        continue;
      }
      const am = ASSIGN.exec(line);
      if (am && !/^(return|if|for|while|with|import|from|else|elif|try|except)\b/.test(line)) {
        const name = am[2] ?? am[6];
        variables.push({ name, type: (am[3] ?? am[7])?.trim(), visibility: visibility(name), isStatic: true, isReadonly: /^[A-Z_0-9]+$/.test(name), flags: [], init: am[4]?.trim().slice(0, 600), line: i + 1 });
      }
    }
  }
  return { types, functions, variables };
}
