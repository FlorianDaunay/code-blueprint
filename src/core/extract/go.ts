import type { FieldInfo, ImportInfo, MethodInfo, ParamInfo, TypeInfo } from "../model";
import { baseTypeName, lineAt, matchBracket, splitTopLevel } from "../strip";
import type { ParsedFile } from "./clike";

const BODY_LIMIT = 6000;
const vis = (name: string): "public" | "package" => (/^[A-Z]/.test(name) ? "public" : "package");

export function goImports(code: string, starts: number[]): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const add = (spec: string, alias: string | undefined, offset: number) => {
    imports.push({ spec, names: ["*"], alias: alias && alias !== "_" && alias !== "." ? alias : undefined, kind: "package", line: lineAt(starts, offset) });
  };
  const block = /\bimport\s*\(([\s\S]*?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(code))) {
    const inner = m[1];
    const re = /(?:([\w.]+)\s+)?"([^"]+)"/g;
    let im: RegExpExecArray | null;
    while ((im = re.exec(inner))) add(im[2], im[1], m.index + im.index);
  }
  const single = /\bimport\s+(?:([\w.]+)\s+)?"([^"]+)"/g;
  while ((m = single.exec(code))) add(m[2], m[1], m.index);
  return imports;
}

function params(text: string): ParamInfo[] {
  // Go groups names: `a, b int, c string`.
  const parts = splitTopLevel(text);
  const out: ParamInfo[] = [];
  let pendingNames: string[] = [];
  for (const p of parts) {
    const words = p.split(/\s+/);
    if (words.length === 1) pendingNames.push(words[0]);
    else {
      const type = words.slice(1).join(" ");
      for (const n of [...pendingNames, words[0]]) out.push({ name: n, type });
      pendingNames = [];
    }
  }
  // Unnamed params (only types).
  for (const t of pendingNames) out.push({ name: "", type: t });
  return out;
}

export function parseGo(masked: string, starts: number[]): ParsedFile {
  const types: TypeInfo[] = [];
  const functions: MethodInfo[] = [];
  const variables: FieldInfo[] = [];
  const byName = new Map<string, TypeInfo>();

  const typeRe = /^type\s+([A-Za-z_]\w*)(\[[^\]]*\])?\s+(struct|interface)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    const body = masked.slice(open + 1, close < 0 ? masked.length : close);
    const isInterface = m[3] === "interface";
    const fields: FieldInfo[] = [];
    const methods: MethodInfo[] = [];
    const embedded: string[] = [];
    const bodyStartLine = lineAt(starts, open);
    body.split("\n").forEach((raw, k) => {
      const l = raw.trim().replace(/`.*$/, "").trim();
      if (!l) return;
      if (isInterface) {
        const mm = /^([A-Za-z_]\w*)\s*\((.*)\)\s*(.*)$/.exec(l);
        if (mm) methods.push({ name: mm[1], kind: "method", params: params(mm[2]), returns: mm[3] || undefined, visibility: vis(mm[1]), isStatic: false, isAbstract: true, flags: [], body: "", line: bodyStartLine + k, loc: 1 });
        else if (/^[\w.*]+$/.test(l)) embedded.push(baseTypeName(l));
        return;
      }
      const words = l.split(/\s+/);
      if (words.length === 1) embedded.push(baseTypeName(words[0]));
      else {
        const names = l.slice(0, l.search(/\s/)).split(",");
        const type = l.slice(l.search(/\s/)).trim();
        for (const n of names) fields.push({ name: n.trim(), type, visibility: vis(n.trim()), isStatic: false, isReadonly: false, flags: [], line: bodyStartLine + k });
      }
    });
    const t: TypeInfo = {
      name: m[1], kind: isInterface ? "interface" : "struct", isAbstract: isInterface, isFinal: !isInterface, isExported: /^[A-Z]/.test(m[1]),
      extends: embedded, implements: [], fields, methods, decorators: [], line: lineAt(starts, m.index), endLine: close >= 0 ? lineAt(starts, close) : lineAt(starts, open),
    };
    types.push(t);
    byName.set(t.name, t);
  }

  const funcRe = /^func\s*(\(\s*(\w+)?\s*\*?\s*([A-Za-z_]\w*)(\[[^\]]*\])?\s*\))?\s*([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\(/gm;
  while ((m = funcRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const brace = masked.indexOf("{", close);
    const nl = masked.indexOf("\n", close);
    const returns = masked.slice(close + 1, brace >= 0 && (nl < 0 || brace < nl) ? brace : nl).trim().replace(/^\(|\)$/g, "") || undefined;
    const bodyEnd = brace >= 0 ? matchBracket(masked, brace) : -1;
    const body = brace >= 0 && bodyEnd > 0 ? masked.slice(brace + 1, bodyEnd) : "";
    const line = lineAt(starts, m.index);
    const name = m[5];
    const method: MethodInfo = {
      name, kind: "method", params: params(masked.slice(open + 1, close)), returns, visibility: vis(name), isStatic: !m[1], isAbstract: false,
      flags: m[1] ? (m[0].includes("*") ? ["pointer-receiver"] : []) : [], body: body.slice(0, BODY_LIMIT), line,
      loc: bodyEnd > 0 ? lineAt(starts, bodyEnd) - line + 1 : 1,
    };
    const receiver = m[3];
    if (receiver && byName.has(receiver)) byName.get(receiver)!.methods.push(method);
    else if (receiver) {
      // Method on a type declared in another file of the package: keep it as a placeholder type.
      const t: TypeInfo = { name: receiver, kind: "struct", isAbstract: false, isFinal: true, isExported: /^[A-Z]/.test(receiver), extends: [], implements: [], fields: [], methods: [method], decorators: ["partial"], line, endLine: line };
      types.push(t);
      byName.set(receiver, t);
    } else functions.push(method);
  }

  const varRe = /^(var|const)\s+(\(([\s\S]*?)^\)|([A-Za-z_]\w*)[^\n]*)/gm;
  while ((m = varRe.exec(masked))) {
    const isConst = m[1] === "const";
    const lines = m[3] !== undefined ? m[3].split("\n") : [m[2]];
    const baseLine = lineAt(starts, m.index) + (m[3] !== undefined ? 1 : 0);
    lines.forEach((raw, k) => {
      const l = raw.trim();
      const vm = /^([A-Za-z_]\w*)\s*([^=]*?)\s*(=\s*(.*))?$/.exec(l);
      if (!vm || !l) return;
      variables.push({ name: vm[1], type: vm[2] || undefined, visibility: vis(vm[1]), isStatic: true, isReadonly: isConst, flags: isConst ? ["const"] : [], init: vm[4]?.slice(0, 600), line: baseLine + k });
    });
  }
  return { types, functions, variables };
}
