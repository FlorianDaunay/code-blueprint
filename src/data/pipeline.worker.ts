/// <reference lib="webworker" />
import { analyze } from "../core/analyze";
import { isIgnoredPath, isResolverConfig, isTestPath, langOf } from "../core/languages";
import { PARSED_LANGS, type Analysis, type Progress } from "../core/model";
import { cacheKey, readCache, writeCache } from "./cache";
import { FetchError, fetchMeta, fetchRaw, fetchTree, fetchTreeFallback, parseRepoInput, pool, type Tree } from "./github";

export type WorkerRequest = { type: "analyze"; input: string; force?: boolean; maxFiles?: number };
export type WorkerResponse =
  | { type: "progress"; progress: Progress }
  | { type: "done"; analysis: Analysis; fromCache: boolean }
  | { type: "error"; code: FetchError["code"]; message: string; resetAt?: number };

/** Content analysis caps: every file is still placed on the map, only parsing is limited. */
const DEFAULT_MAX_FILES = 4000;
const MAX_FILE_BYTES = 400_000;
const CONCURRENCY = 24;

const post = (msg: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
const progress = (p: Progress) => post({ type: "progress", progress: p });

async function run(req: WorkerRequest) {
  const startedAt = Date.now();
  const input = parseRepoInput(req.input);
  if (!input) throw new FetchError("invalid-input", "Expected owner/repo or a GitHub URL.");
  const { owner, repo, path } = input;
  const refKey = cacheKey(owner, repo, input.ref ?? "default", path);

  progress({ phase: "meta" });
  let ref = input.ref;
  let tree: Tree;
  try {
    if (!ref) ref = (await fetchMeta(owner, repo)).defaultBranch;
    progress({ phase: "tree" });
    tree = await fetchTree(owner, repo, ref);
  } catch (error) {
    if (!(error instanceof FetchError) || error.code !== "rate-limit") throw error;
    // Rate limited: last analysis of this repo if we have one, else the jsDelivr mirror.
    const cached = !req.force && (await readCache(refKey));
    if (cached) {
      post({ type: "done", analysis: cached, fromCache: true });
      return;
    }
    const fb = await fetchTreeFallback(owner, repo, ref);
    ref = fb.ref;
    tree = fb.tree;
  }

  const key = cacheKey(owner, repo, tree.sha, path);
  if (!req.force) {
    progress({ phase: "cache" });
    const cached = await readCache(key);
    if (cached) {
      post({ type: "done", analysis: cached, fromCache: true });
      return;
    }
  }

  const prefix = path ? path.replace(/\/+$/, "") + "/" : "";
  const inScope = tree.entries.filter((e) => (!prefix || e.path.startsWith(prefix)) && !isIgnoredPath(e.path));
  const code = inScope.filter((e) => langOf(e.path) !== null);
  if (!code.length) throw new FetchError("empty", "No source code found in this repository.");
  const configs = tree.entries.filter((e) => isResolverConfig(e.path) && !isIgnoredPath(e.path) && e.size < 200_000).slice(0, 150);

  // Parse what we can: production code first, shallow paths first.
  const parseable = code.filter((e) => PARSED_LANGS.includes(langOf(e.path)!));
  const tooBig = parseable.filter((e) => e.size > MAX_FILE_BYTES);
  const candidates = parseable
    .filter((e) => e.size <= MAX_FILE_BYTES)
    .sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  const maxFiles = req.maxFiles ?? DEFAULT_MAX_FILES;
  const toFetch = candidates.slice(0, maxFiles);
  const skipped = [
    { reason: "larger than 400 KB", count: tooBig.length },
    { reason: `beyond the ${maxFiles}-file analysis cap`, count: Math.max(0, candidates.length - maxFiles) },
    { reason: "language not parsed (placed by size)", count: code.length - parseable.length },
  ].filter((s) => s.count > 0);

  const contents = new Map<string, string>();
  const configTexts: { path: string; text: string }[] = [];
  let done = 0;
  let lastPost = 0;
  const all = [...configs.map((c) => ({ ...c, config: true })), ...toFetch.map((c) => ({ ...c, config: false }))];
  await pool(all, CONCURRENCY, async (entry) => {
    try {
      const text = await fetchRaw(owner, repo, tree.sha, entry.path, tree.source);
      if (entry.config) configTexts.push({ path: entry.path.slice(prefix.length), text });
      else contents.set(entry.path.slice(prefix.length), text);
    } catch {
      // A file that can't be downloaded stays on the map with its estimated size.
    }
    done++;
    const now = Date.now();
    if (now - lastPost > 80 || done === all.length) {
      lastPost = now;
      progress({ phase: "fetch", done, total: all.length });
    }
  });

  progress({ phase: "analyze" });
  const analysis = analyze({
    repo: { owner, repo, ref: ref!, sha: tree.sha, path },
    entries: code.map((e) => ({ path: e.path.slice(prefix.length), size: e.size, sha: e.sha })),
    contents,
    configs: configTexts,
    skipped,
    treeTruncated: tree.truncated,
    startedAt,
  });
  await writeCache(key, analysis);
  await writeCache(refKey, analysis);
  post({ type: "done", analysis, fromCache: false });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  run(event.data).catch((error: unknown) => {
    if (error instanceof FetchError) post({ type: "error", code: error.code, message: error.message, resetAt: error.resetAt });
    else post({ type: "error", code: "network", message: error instanceof Error ? error.message : String(error) });
  });
};
