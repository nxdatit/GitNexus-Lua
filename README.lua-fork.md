# GitNexus — Lua Language Fork

> Fork of [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus) that adds first-class **Lua language support** to the code intelligence pipeline. Lua changes live on the [`lua-support`](https://github.com/nxdatit/GitNexus/tree/lua-support) branch; `main` mirrors upstream so syncing with new upstream releases is straightforward.

**Status:** upstream v1.6.0 + Lua support on top. Tested against a ~1600-file Lua codebase (game-modding auto-script project).

---

## Why this fork

Upstream GitNexus supports 15+ languages (TypeScript, JavaScript, Python, Java, C, C++, C#, Go, Ruby, Rust, PHP, Kotlin, Swift, Dart, Vue, COBOL) as of v1.6.0 — but **no Lua**. This fork fills that gap so Lua codebases (game mods, addons, LÖVE projects, WoW addons, auto-scripts, etc.) can benefit from the same knowledge-graph intelligence — call graphs, impact analysis, and MCP integration with Claude Code / Cursor.

---

## What works today

| Capability | Detail |
|---|---|
| **Lua parser** | `@tree-sitter-grammars/tree-sitter-lua@0.2.0` — works on `.lua` files |
| **Function / Method extraction** | `function foo()`, `local function foo()`, `function M.foo()`, `function M:bar()` |
| **`require()` import binding** | `local X = require("mod.path")` — X aliases the module file |
| **Dot-form CALLS** | `X.foo()`, `module.fn()` resolved cross-file |
| **Method-form declarations** | `function M:bar()` captured as Method nodes |
| **Wildcard wiring for globals** | Game-engine Lua codebases rarely use `require()` — they declare top-level globals (`Me = class(Player)` in `Me.lua`). This fork wires an implicit IMPORTS edge from every Lua file to every other Lua file, and the existing wildcard-synthesis pipeline then derives `<basename>` → `<file>` aliases. `Me.foo()` callers resolve to `Me.lua` without any require. |
| **Override detection (monkey-patch)** | Standalone script (`gitnexus/scripts/detect-lua-overrides.mjs`) scans a project after `analyze`, detects runtime patch idioms, and emits `METHOD_OVERRIDES` edges in the graph. |

### Override patterns detected

1. **Helper-based**
    ```lua
    HvsMain:BackupFunc(CameraEffectMgr, "Play")
    CameraEffectMgr.Play = function(...)
      -- custom behaviour
      CameraEffectMgr.Play_org(...)
    end
    ```
2. **Helper combo**
    ```lua
    HvsMain:ModifyFunc(Obj, "method", function(...) ... end)
    ```
3. **Inline save + overwrite**
    ```lua
    Me.StopMoveImmediate_bak = Me.StopMoveImmediate_bak or Me.StopMoveImmediate
    Me.StopMoveImmediate = function(...)
      -- custom
      Me.StopMoveImmediate_bak(...)
    end
    ```
    Suffix variants recognised: `_bak`, `_org`, `_backup`, `_origin`.

These patterns are common in game-modding, auto-script, and addon projects where the author extends engine behaviour at runtime without touching the engine source.

---

## Limitations

| Issue | Why | Workaround |
|---|---|---|
| Colon-form calls `obj:method()` don't resolve cross-file | Needs type inference for the receiver; Lua has no static types | Use `grep` or `cypher` query to find Method nodes by name manually |
| `setmetatable(__index = parent)` inheritance not traced | Metatable pattern is runtime — static analyser cannot follow | Document in code; rely on community detection for cohesion |
| Dynamic dispatch `obj[varName]()` | Target unknown without runtime info | — |
| LuaDoc (`---@param`, `---@return`) annotations ignored | No type-extractor implementation | Future work |
| Simple-replace override (`function Obj.foo()` without backup) | Cross-file symbol lookup not implemented in the detection script | Future work |

---

## Install from this fork

```bash
# Clone the Lua-support branch
git clone -b lua-support https://github.com/nxdatit/GitNexus.git
cd GitNexus/gitnexus

# Build + link
npm install
npm run build
npm link

# Verify
npx gitnexus --version
```

---

## Use on a Lua project

```bash
cd /path/to/your-lua-project

# GitNexus requires a git repo — create one if needed
git init && git add -A && git commit -m "baseline"

# Analyze (8GB Node heap helps for 1000+ file projects)
NODE_OPTIONS="--max-old-space-size=8192" npx gitnexus analyze --force

# Optional: emit METHOD_OVERRIDES edges for runtime patch patterns
# (Stop any running `npx gitnexus mcp` first — LadybugDB is single-writer.)
node /path/to/fork/GitNexus/gitnexus/scripts/detect-lua-overrides.mjs --emit

# Inspect the graph
npx gitnexus query "your search"
npx gitnexus context SomeFunction
npx gitnexus impact SomeFunction --direction upstream
```

---

## Architecture pointers

New / modified files introduced by this fork:

| Concern | File |
|---|---|
| Enum + extension map | `gitnexus-shared/src/languages.ts`, `language-detection.ts` |
| Parser loader (main thread) | `gitnexus/src/core/tree-sitter/parser-loader.ts` |
| Parser loader (worker thread — duplicated upstream) | `gitnexus/src/core/ingestion/workers/parse-worker.ts` |
| Lua language provider | `gitnexus/src/core/ingestion/languages/lua.ts` |
| Tree-sitter queries (definitions / calls / imports) | `gitnexus/src/core/ingestion/tree-sitter-queries.ts` — `LUA_QUERIES` block |
| Export checker (local = private) | `gitnexus/src/core/ingestion/export-detection.ts` — `luaExportChecker` |
| Import resolver (`require("a.b.c")`) | `gitnexus/src/core/ingestion/import-resolvers/lua.ts` |
| Named binding (`local X = require(...)`) | `gitnexus/src/core/ingestion/named-bindings/lua.ts` |
| Type extractor (no-op) | `gitnexus/src/core/ingestion/type-extractors/lua.ts` |
| Entry-point patterns | `gitnexus/src/core/ingestion/entry-point-scoring.ts` |
| Framework detection (empty) | `gitnexus/src/core/ingestion/framework-detection.ts` |
| Language registry | `gitnexus/src/core/ingestion/languages/index.ts` |
| Override detection script | `gitnexus/scripts/detect-lua-overrides.mjs` |

---

## Sync with upstream

`main` branch tracks `upstream/main` — kept clean, no Lua changes.

```bash
git fetch upstream
git checkout main
git merge upstream/main       # fast-forward
git push origin main

git checkout lua-support
git rebase main               # replay Lua commits on the new upstream
# resolve conflicts if any (usually in tree-sitter-queries.ts or parse-worker.ts)
cd gitnexus && npm install && npm run build && npm link
cd ..
git push --force-with-lease origin lua-support
```

---

## License

Unchanged from upstream: **PolyForm Noncommercial 1.0.0** — see [LICENSE](./LICENSE). Personal, educational, and non-commercial use only.

Credit: all upstream commits and authors preserved in the history. This fork is maintained independently; report Lua-specific issues to this fork, not to upstream.
