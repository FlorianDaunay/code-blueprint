# code·blueprint

Paste any **public GitHub repository** and explore it as an interactive **3D code city**:

- **Towers = files** (height ~ code lines, width ~ members), **platforms = folders**, **arcs = dependencies** (cyan: uses, pink: used by).
- **Health lens**: fixed rules (circular dependencies, package cycles, layer violations, oversized files, god classes, long methods, hubs, fan-out, deep inheritance, test code in production, broken imports, unreferenced files, crowded folders).
- **Patterns lens**: 18 design patterns detected (Singleton, Factory, Factory Method, Abstract Factory, Builder, Adapter, Decorator, Proxy, Composite, Facade, Observer, Strategy, State, Command, Template Method, Chain of Responsibility, Visitor, Repository). Each one gets a verdict (**complete / partial / flawed**) with what is in place, what is **missing**, and what **shouldn't be there**.
- **Coupling lens**: connection heat, hubs glow.

Minimal text by default: click a tower, folder, finding or pattern to drill down.

Languages parsed: TypeScript, JavaScript (incl. Vue/Svelte scripts), Python, Java, Kotlin, C#, Go, PHP. Other code files are placed on the map by size.

## How it works

100% front-end, no server, no auth:

1. GitHub REST API: 2 calls per analysis (repo + recursive tree). Anonymous limit: 60/hour. When it is reached, the file list falls back to the jsDelivr mirror, or to the last cached analysis.
2. Sources from `raw.githubusercontent.com` (not rate-limited), in a Web Worker.
3. Lightweight per-language extractors (comment/string-aware lexer + structural parser) → imports, types, members → dependency graph, type model, rules, pattern detectors.
4. Squarified treemap layout → instanced three.js rendering (one draw call for all towers), bloom, flowing arcs.
5. Results cached in IndexedDB per commit.

Large repositories stay on a single map: every file is placed, content analysis is capped (4,000 files, 400 KB per file).

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest (extractors, resolution, rules, patterns)
npm run build      # typecheck + static build in dist/
```

Deep links: `#/owner/repo` or `#/owner/repo/tree/<ref>/<sub/path>`.
Keys: `1-4` lenses · `/` search · `A` all dependencies · `I` isometric · `R` reset view · `Esc` back.

## Deploy

GitHub Pages via `.github/workflows/deploy.yml` (Settings → Pages → Source: **GitHub Actions**).

Stack: vanilla TypeScript, Vite, three.js, vitest. No UI framework.

## Compare versions (diff city)

Press `C` (or the compare button) and pick a tag, branch or commit: the map becomes the union of both versions.
Green towers were added, amber modified, red wireframe ghosts were removed; green/red arcs are new/vanished dependencies.
The *Changes* panel lists new and fixed findings, pattern regressions and improvements, and the most changed files.
Deep link: `#/owner/repo?cmp=<base-ref>`.
