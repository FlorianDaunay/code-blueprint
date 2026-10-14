/**
 * Public GitHub access without authentication.
 * - 2 REST calls per analysis (repo metadata + recursive tree): the anonymous limit is 60/hour.
 * - File contents come from raw.githubusercontent.com (CORS enabled, not counted in that limit).
 * - When the REST limit is hit, the file list falls back to jsDelivr's GitHub mirror.
 */

export interface RepoInput {
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
}

export class FetchError extends Error {
  constructor(
    public code: "invalid-input" | "not-found" | "rate-limit" | "network" | "empty" | "too-large",
    message: string,
    public resetAt?: number,
  ) {
    super(message);
  }
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Accepts `owner/repo`, GitHub URLs (with `/tree/<ref>/<path>`), `.git` suffixes. */
export function parseRepoInput(raw: string): RepoInput | null {
  let s = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/^git@github\.com:/i, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2 || !NAME.test(parts[0]) || !NAME.test(parts[1])) return null;
  const out: RepoInput = { owner: parts[0], repo: parts[1] };
  if ((parts[2] === "tree" || parts[2] === "blob") && parts[3]) {
    out.ref = decodeURIComponent(parts[3]);
    if (parts.length > 4) out.path = parts.slice(4).map(decodeURIComponent).join("/");
  }
  return out;
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  } catch {
    throw new FetchError("network", "Network error while contacting GitHub.");
  }
  if (res.status === 404) throw new FetchError("not-found", "Repository not found (or private).");
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000 || undefined;
    throw new FetchError("rate-limit", "GitHub API rate limit reached for anonymous requests.", reset);
  }
  if (!res.ok) throw new FetchError("network", `GitHub answered ${res.status}.`);
  return (await res.json()) as T;
}

export interface RepoMeta {
  defaultBranch: string;
  description: string;
  stars: number;
  /** KB, as reported by GitHub. */
  size: number;
}

export async function fetchMeta(owner: string, repo: string): Promise<RepoMeta> {
  const json = await getJson<{ default_branch: string; description: string | null; stargazers_count: number; size: number }>(`https://api.github.com/repos/${owner}/${repo}`);
  return { defaultBranch: json.default_branch, description: json.description ?? "", stars: json.stargazers_count, size: json.size };
}

export interface TreeEntry {
  path: string;
  size: number;
}

export interface Tree {
  sha: string;
  entries: TreeEntry[];
  truncated: boolean;
  source: "github" | "jsdelivr";
}

export async function fetchTree(owner: string, repo: string, ref: string): Promise<Tree> {
  const json = await getJson<{ sha: string; truncated: boolean; tree: { path: string; type: string; size?: number }[] }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  return {
    sha: json.sha,
    truncated: json.truncated,
    entries: json.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, size: e.size ?? 0 })),
    source: "github",
  };
}

/** File list from jsDelivr (no GitHub rate limit). Needs a ref; tries common branch names when unknown. */
export async function fetchTreeFallback(owner: string, repo: string, ref?: string): Promise<{ ref: string; tree: Tree }> {
  const refs = ref ? [ref] : ["main", "master", "develop", "trunk"];
  for (const r of refs) {
    let res: Response;
    try {
      res = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${encodeURIComponent(r)}?structure=flat`);
    } catch {
      throw new FetchError("network", "Network error while contacting jsDelivr.");
    }
    if (!res.ok) continue;
    const json = (await res.json()) as { files?: { name: string; size: number; hash?: string }[] };
    if (!json.files) continue;
    return { ref: r, tree: { sha: r, truncated: false, entries: json.files.map((f) => ({ path: f.name.replace(/^\//, ""), size: f.size })), source: "jsdelivr" } };
  }
  throw new FetchError("rate-limit", "GitHub API rate limit reached and the jsDelivr mirror has no copy of this repository.");
}

export async function fetchRaw(owner: string, repo: string, sha: string, path: string, source: Tree["source"]): Promise<string> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = source === "github" ? `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${encoded}` : `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${sha}/${encoded}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      if (res.status === 404) throw new FetchError("not-found", path);
    } catch (error) {
      if (error instanceof FetchError) throw error;
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  throw new FetchError("network", `Could not download ${path}`);
}

/** Runs `task` over `items` with at most `limit` in flight. */
export async function pool<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
