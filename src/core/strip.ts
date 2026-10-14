import type { Lang } from "./model";

export interface Stripped {
  /** Comments blanked (replaced by spaces, newlines kept); strings intact. Use for import specifiers. */
  code: string;
  /** Comments blanked and string/regex *contents* blanked (delimiters kept). Use for structure. */
  masked: string;
}

interface LexConfig {
  line: string[];
  block: boolean;
  triple: boolean;
  backtick: "template" | "raw" | null;
  regex: boolean;
  verbatim: boolean;
}

const C_LIKE: LexConfig = { line: ["//"], block: true, triple: false, backtick: null, regex: false, verbatim: false };

const LEX: Record<Lang, LexConfig> = {
  typescript: { ...C_LIKE, backtick: "template", regex: true },
  javascript: { ...C_LIKE, backtick: "template", regex: true },
  java: { ...C_LIKE, triple: true },
  kotlin: { ...C_LIKE, triple: true },
  csharp: { ...C_LIKE, triple: true, verbatim: true },
  go: { ...C_LIKE, backtick: "raw" },
  php: { ...C_LIKE, line: ["//", "#"] },
  python: { line: ["#"], block: false, triple: true, backtick: null, regex: false, verbatim: false },
  other: C_LIKE,
};

const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/**
 * Single-pass lexer that removes comments and blanks string contents while keeping every
 * character offset and line number unchanged, so later regex/brace scans stay accurate.
 */
export function strip(source: string, lang: Lang): Stripped {
  const cfg = LEX[lang];
  const n = source.length;
  const code = source.split("");
  const masked = source.split("");
  const blankCode = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (code[k] !== "\n") code[k] = " ";
  };
  const blankMasked = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (masked[k] !== "\n") masked[k] = " ";
  };
  const blankBoth = (from: number, to: number) => {
    blankCode(from, to);
    blankMasked(from, to);
  };

  /** Skips a quoted string starting at `i` (the quote); returns the index after the closing quote. */
  const skipString = (i: number, quote: string, escapes: boolean): number => {
    let j = i + quote.length;
    while (j < n) {
      if (escapes && source[j] === "\\") {
        j += 2;
        continue;
      }
      if (source.startsWith(quote, j)) {
        // C# verbatim: doubled quote is an escaped quote.
        if (!escapes && quote === '"' && source[j + 1] === '"') {
          j += 2;
          continue;
        }
        return j + quote.length;
      }
      if (quote.length === 1 && source[j] === "\n" && quote !== "`") return j; // unterminated
      j++;
    }
    return n;
  };

  /** Template literal with nested `${ ... }` expressions (which may contain templates). */
  const skipTemplate = (i: number): number => {
    let j = i + 1;
    while (j < n) {
      const c = source[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") return j + 1;
      if (c === "$" && source[j + 1] === "{") {
        j += 2;
        let depth = 1;
        while (j < n && depth > 0) {
          const d = source[j];
          if (d === "{") depth++;
          else if (d === "}") depth--;
          else if (d === "`") {
            j = skipTemplate(j);
            continue;
          } else if (d === '"' || d === "'") {
            j = skipString(j, d, true);
            continue;
          }
          j++;
        }
        continue;
      }
      j++;
    }
    return n;
  };

  const prevSignificant = (i: number): string => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    return k >= 0 ? code[k] : "";
  };

  let i = 0;
  while (i < n) {
    const c = source[i];

    // Comments.
    if (cfg.block && c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      blankBoth(i, stop);
      i = stop;
      continue;
    }
    let isLineComment = false;
    for (const token of cfg.line) {
      if (source.startsWith(token, i)) {
        // PHP 8 attributes `#[...]` are not comments.
        if (token === "#" && lang === "php" && source[i + 1] === "[") continue;
        isLineComment = true;
      }
    }
    if (isLineComment) {
      let end = source.indexOf("\n", i);
      if (end < 0) end = n;
      blankBoth(i, end);
      i = end;
      continue;
    }

    // Strings.
    if (cfg.triple && (source.startsWith('"""', i) || (lang === "python" && source.startsWith("'''", i)))) {
      const quote = source.slice(i, i + 3);
      const end = source.indexOf(quote, i + 3);
      const stop = end < 0 ? n : end + 3;
      blankMasked(i + 3, stop - 3);
      i = stop;
      continue;
    }
    if (cfg.verbatim && c === "@" && source[i + 1] === '"') {
      const stop = skipString(i + 1, '"', false);
      blankMasked(i + 2, stop - 1);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const stop = skipString(i, c, true);
      blankMasked(i + 1, stop - 1);
      i = stop;
      continue;
    }
    if (c === "`" && cfg.backtick) {
      const stop = cfg.backtick === "template" ? skipTemplate(i) : skipString(i, "`", false);
      blankMasked(i + 1, stop - 1);
      i = stop;
      continue;
    }

    // JS regex literal: a `/` where an expression may start.
    if (cfg.regex && c === "/" && source[i + 1] !== "/" && source[i + 1] !== "*") {
      const prev = prevSignificant(i);
      const before = source.slice(Math.max(0, i - 7), i);
      if (prev === "" || REGEX_PRECEDERS.has(prev) || /\b(return|typeof|case|in|of|yield|await)\s*$/.test(before)) {
        let j = i + 1;
        let inClass = false;
        while (j < n && source[j] !== "\n") {
          const d = source[j];
          if (d === "\\") {
            j += 2;
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          j++;
        }
        if (source[j] === "/") {
          blankMasked(i + 1, j);
          i = j + 1;
          continue;
        }
      }
    }
    i++;
  }
  return { code: code.join(""), masked: masked.join("") };
}

/** Line number (1-based) of a character offset. Use with a precomputed `lineStarts` for many lookups. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Index of the bracket matching the one at `open` in masked text, or -1. */
export function matchBracket(masked: string, open: number): number {
  const o = masked[open];
  const c = o === "{" ? "}" : o === "(" ? ")" : o === "[" ? "]" : o === "<" ? ">" : "";
  if (!c) return -1;
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Counts non-blank lines. */
export function countLoc(text: string): number {
  let count = 0;
  let blank = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      if (!blank) count++;
      blank = true;
    } else if (ch !== 32 && ch !== 9 && ch !== 13) blank = false;
  }
  return blank ? count : count + 1;
}

/** Rough cyclomatic complexity: 1 + decision points. */
export function complexityOf(masked: string): number {
  const m = masked.match(/\b(if|elif|for|foreach|while|case|catch|except|when)\b|&&|\|\||\?\?|\?(?=[^.:?])/g);
  return 1 + (m ? m.length : 0);
}

/** Splits on commas at bracket depth 0 (`a, Map<K, V>, f(x, y)` → 3 parts). */
export function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || (ch === ">" && text[i - 1] !== "=" && text[i - 1] !== "-")) depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** `Base<T>` → `Base`, `pkg.Base` → `Base`, `?Foo` → `Foo`, `*Foo` → `Foo`. */
export function baseTypeName(type: string): string {
  const cleaned = type.replace(/<[\s\S]*$/, "").replace(/\[[\s\S]*$/, "").replace(/[?*&!]/g, "").trim();
  const parts = cleaned.split(/\.|\\|::/);
  return parts[parts.length - 1].trim();
}
