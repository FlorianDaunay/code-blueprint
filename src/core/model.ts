/**
 * The data model shared by the analysis pipeline (worker) and the UI (main thread).
 * Everything here is plain data: structured-clone friendly and cacheable.
 */

export type Lang =
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "kotlin"
  | "csharp"
  | "go"
  | "php"
  | "other";

/** Languages we have an extractor for. */
export const PARSED_LANGS: readonly Lang[] = ["typescript", "javascript", "python", "java", "kotlin", "csharp", "go", "php"];

export type Visibility = "public" | "protected" | "private" | "internal" | "package";

export interface ParamInfo {
  name: string;
  type?: string;
}

export interface MethodInfo {
  name: string;
  kind: "method" | "ctor" | "getter" | "setter";
  params: ParamInfo[];
  returns?: string;
  visibility: Visibility;
  isStatic: boolean;
  isAbstract: boolean;
  /** Language-level modifiers or decorators worth knowing (`synchronized`, `override`, `classmethod`...). */
  flags: string[];
  /** Body with comments removed and string contents blanked; truncated for very long methods. */
  body: string;
  line: number;
  loc: number;
}

export interface FieldInfo {
  name: string;
  type?: string;
  visibility: Visibility;
  isStatic: boolean;
  isReadonly: boolean;
  /** Language modifiers worth knowing (`event`, `const`, `lateinit`...). */
  flags: string[];
  /** Initializer expression (masked), when short. */
  init?: string;
  line: number;
}

export type TypeKind = "class" | "interface" | "enum" | "struct" | "trait" | "object" | "record";

export interface TypeInfo {
  name: string;
  kind: TypeKind;
  isAbstract: boolean;
  /** `final` / `sealed` / not open (Kotlin) — cannot be subclassed. */
  isFinal: boolean;
  isExported: boolean;
  /** Raw names as written (`Base<T>` → `Base`). */
  extends: string[];
  implements: string[];
  fields: FieldInfo[];
  methods: MethodInfo[];
  /** Namespace / package / module the type lives in (`com.acme.core`, `App\\Models`). */
  namespace?: string;
  decorators: string[];
  line: number;
  endLine: number;
}

export interface ImportInfo {
  /** As written: `./util`, `com.acme.Foo`, `App\\Models\\User`, `github.com/x/y/pkg`. */
  spec: string;
  /** Names bound by the import (`{A, B}` → A, B); `*` for wildcard/namespace imports. */
  names: string[];
  /** Alias used in code for the module/package (`import * as x`, Go `x "pkg"`, Python `import a as b`). */
  alias?: string;
  /** Python relative import level (number of leading dots). */
  level?: number;
  kind: "module" | "type" | "namespace" | "package" | "include";
  /** Imported inside a function body (deferred until called): the classic way to break a runtime cycle. */
  lazy?: boolean;
  line: number;
}

export interface SourceInfo {
  imports: ImportInfo[];
  types: TypeInfo[];
  /** Top-level functions (module functions, Go funcs without receiver...). */
  functions: MethodInfo[];
  /** Top-level variables/constants (used for module singletons, Go same-package refs). */
  variables: FieldInfo[];
  /** Namespace / package declared by the file. */
  namespace?: string;
  /** Identifiers referenced (for languages with implicit same-package visibility). */
  refs: string[];
  /** `alias.Name` selector refs (Go). */
  selectors: string[];
  loc: number;
  lines: number;
  complexity: number;
}

export interface FileNode {
  id: number;
  path: string;
  name: string;
  dir: string;
  ext: string;
  lang: Lang;
  /** Bytes, from the tree listing. */
  size: number;
  /** Content hash from the tree listing (detects modified files when comparing refs). */
  blob?: string;
  /** Code lines when analyzed, estimated from size otherwise. */
  loc: number;
  analyzed: boolean;
  isTest: boolean;
  /** Present for analyzed files (dropped from the light view model). */
  source?: SourceInfo;
  /** Imports that look local but could not be resolved. */
  unresolved: string[];
  /** External packages imported (npm, pip, maven...). */
  externals: string[];
}

export type EdgeKind = "import" | "inherit";

export interface Edge {
  from: number;
  to: number;
  kind: EdgeKind;
  /** Number of imports / references folded into this edge. */
  weight: number;
  /** Every import behind this edge is deferred (function-local): ignored by the cycle rule. */
  lazy?: boolean;
}

export interface DirNode {
  path: string;
  name: string;
  parent: string | null;
  depth: number;
  children: string[];
  files: number[];
  /** Total code lines below this directory. */
  loc: number;
  fileCount: number;
}

/** Reference to a type in the global model: `fileId:index`. */
export type TypeRef = string;

export type Severity = "error" | "warning" | "info";

export interface Issue {
  id: string;
  rule: string;
  severity: Severity;
  /** Files involved, first one is the main location. */
  files: number[];
  /** Directories involved (directory-level rules). */
  dirs: string[];
  /** Edges involved (cycles, violations): pairs of file ids. */
  edges: [number, number][];
  /** Short title, e.g. "Circular dependency (4 files)". */
  title: string;
  /** One or two sentences, shown on demand. */
  detail: string;
  /** Measured value vs limit, when the rule is a threshold. */
  metric?: { value: number; limit: number; unit: string };
}

export type PatternVerdict = "complete" | "partial" | "flawed";

export interface PatternCheck {
  /** `required`: defines the pattern; `recommended`: good practice; `anti`: should not be there. */
  kind: "required" | "recommended" | "anti";
  ok: boolean;
  label: string;
  hint?: string;
}

export interface PatternRole {
  role: string;
  types: { file: number; name: string; line: number }[];
}

export interface PatternMatch {
  id: string;
  pattern: string;
  verdict: PatternVerdict;
  /** 0..1, share of checks passed (anti checks count as failures when present). */
  score: number;
  /** 0..1 confidence that this really is the pattern (naming + structure signals). */
  confidence: number;
  roles: PatternRole[];
  files: number[];
  checks: PatternCheck[];
  summary: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit as requested. */
  ref: string;
  /** Resolved commit / tree sha. */
  sha: string;
  /** Optional sub-path to restrict the map to. */
  path?: string;
}

export interface AnalysisStats {
  files: number;
  analyzedFiles: number;
  loc: number;
  dirs: number;
  edges: number;
  langs: Record<string, number>;
  externals: { name: string; count: number }[];
  /** Why some files were not analyzed (caps, size). */
  skipped: { reason: string; count: number }[];
  treeTruncated: boolean;
  durationMs: number;
}

export interface Analysis {
  version: number;
  repo: RepoRef;
  createdAt: number;
  files: FileNode[];
  dirs: DirNode[];
  edges: Edge[];
  issues: Issue[];
  patterns: PatternMatch[];
  stats: AnalysisStats;
}

/** Bump when the shape or semantics of `Analysis` change: invalidates caches. */
export const ANALYSIS_VERSION = 3;

export type Progress =
  | { phase: "meta" | "tree" | "analyze" | "cache"; message?: string }
  | { phase: "fetch"; done: number; total: number };
