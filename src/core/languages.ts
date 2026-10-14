import type { Lang } from "./model";

/** Extensions of files we parse. */
const PARSED: Record<string, Lang> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "javascript",
  svelte: "javascript",
  py: "python",
  pyi: "python",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  go: "go",
  php: "php",
};

/** Code we place on the map but do not parse (yet): shown with an estimated size. */
const OTHER_CODE = new Set([
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "rs", "rb", "swift", "m", "mm", "scala", "dart", "lua",
  "ex", "exs", "erl", "hs", "clj", "fs", "r", "jl", "zig", "nim", "groovy", "pl", "sh", "ps1", "sql",
]);

/** Display name of every language, including unparsed ones by extension. */
export const LANG_LABEL: Record<Lang, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  go: "Go",
  php: "PHP",
  other: "Other",
};

export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function langOf(path: string): Lang | null {
  const ext = extOf(path);
  if (path.endsWith(".d.ts") || /\.min\.(js|mjs|cjs)$/.test(path)) return null;
  if (PARSED[ext]) return PARSED[ext];
  return OTHER_CODE.has(ext) ? "other" : null;
}

/** Directories that are never the project's own code. */
const IGNORED_DIRS = new Set([
  "node_modules", "vendor", "bower_components", "dist", "build", "out", "target", "bin", "obj", ".git",
  ".next", ".nuxt", ".svelte-kit", ".output", "coverage", "__pycache__", ".venv", "venv", "env",
  ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".vscode", "Pods", "DerivedData",
  "third_party", "third-party", "external", "generated", "__generated__", ".yarn", "site-packages",
]);

export function isIgnoredPath(path: string): boolean {
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORED_DIRS.has(parts[i])) return true;
  }
  const name = parts[parts.length - 1];
  return /(\.min\.|\.bundle\.|\.generated\.|\.pb\.go$|_pb2\.py$|\.g\.cs$|\.designer\.cs$)/i.test(name);
}

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|testing|e2e|test-?utils|fixtures|__mocks__|mocks?)\//i;
const TEST_FILE = /(\.|_|-)(test|spec|tests|e2e)\.[a-z]+$|^test_.*\.py$|Tests?\.(java|kt|cs)$|_test\.go$|Test\.php$/i;

export function isTestPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return TEST_DIR.test(path) || TEST_FILE.test(name);
}

/** Rough code lines from a byte size, used until (or instead of) parsing. */
export function estimateLoc(size: number): number {
  return Math.max(1, Math.round(size / 32));
}

/** Small config files that help resolving imports. */
export function isResolverConfig(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^(tsconfig(\.[\w-]+)?\.json|jsconfig\.json|package\.json|go\.mod|composer\.json)$/.test(name);
}
