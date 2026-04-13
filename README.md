# GitNexus-Lua

> Code intelligence engine for **Lua** codebases — builds a queryable knowledge graph (call graphs, import relationships, method overrides) from your source and exposes it to Claude Code / Cursor via MCP.

Based on the [GitNexus](https://github.com/abhigyanpatwari/GitNexus) graph engine (PolyForm Noncommercial license). This project extends it with full Lua language support and runtime monkey-patch detection — features that don't exist upstream.

---

## What this does

Point it at a Lua project. It analyses every `.lua` file, extracts functions / methods / modules, resolves cross-file calls, tracks require-based imports, and detects runtime override patterns. The result is a graph you can query:

- **"Who calls `Player:setHealth`?"** — MCP `context` / `impact` tools
- **"Which functions has my auto-script overridden in the game engine?"** — `METHOD_OVERRIDES` edges
- **"What execution flows touch the combat system?"** — `query` tool with semantic ranking
- **"What breaks if I rename `Monster.Init`?"** — `impact` with depth-graded risk

Works well on game modding codebases, addons, LÖVE / Roblox projects, auto-scripts, and any Lua project using top-level globals instead of require.

---

## Capabilities

| Feature | Detail |
|---|---|
| Lua parser | tree-sitter-lua (v0.2.0) on `.lua` files |
| Function extraction | `function foo()`, `local function foo()`, `function M.foo()`, `function M:bar()` |
| `require()` binding | `local X = require("mod.path")` — X aliases module file |
| Cross-file CALLS | dot-form `X.foo()`, `module.fn()` resolved |
| Global namespace wiring | For engines that use top-level globals (`Me = class(Player)` in `Me.lua`) — every Lua file implicit-imports all others; wildcard synthesis maps receiver name to defining file. No `require()` needed. |
| Runtime override detection | Standalone script emits `METHOD_OVERRIDES` edges for 3 monkey-patch idioms (see below). |
| MCP integration | Works with Claude Code, Cursor, Codex via upstream GitNexus MCP server. |

### Runtime override patterns detected

1. **Helper-based** (`BackupFunc` / `ModifyFunc`)
   ```lua
   HvsMain:BackupFunc(CameraEffectMgr, "Play")
   CameraEffectMgr.Play = function(...)
     -- custom logic
     CameraEffectMgr.Play_org(...)
   end
   ```
2. **Inline save + overwrite** (idempotent backup)
   ```lua
   Me.StopMoveImmediate_bak = Me.StopMoveImmediate_bak or Me.StopMoveImmediate
   Me.StopMoveImmediate = function(...)
     -- custom
     Me.StopMoveImmediate_bak(...)
   end
   ```
3. Suffix variants recognised: `_bak`, `_org`, `_backup`, `_origin`.

---

## Install

```bash
# Clone
git clone https://github.com/nxdatit/GitNexus-Lua.git
cd GitNexus-Lua/gitnexus

# Build + link CLI globally
npm install
npm run build
npm link

# Verify
npx gitnexus --version
```

---

## Usage on a Lua project

```bash
cd /path/to/your-lua-project

# GitNexus requires a git repo
git init && git add -A && git commit -m "baseline"

# Analyze (use 8 GB Node heap for large codebases)
NODE_OPTIONS="--max-old-space-size=8192" npx gitnexus analyze --force

# Optional: detect runtime monkey-patch overrides
# (Stop `npx gitnexus mcp` first — LadybugDB is single-writer.)
node /path/to/GitNexus-Lua/gitnexus/scripts/detect-lua-overrides.mjs --emit

# Query the graph
npx gitnexus query "your search"
npx gitnexus context SomeFunction
npx gitnexus impact SomeFunction --direction upstream
```

See [upstream GitNexus docs](https://github.com/abhigyanpatwari/GitNexus) for the full MCP / CLI feature set — everything there works for Lua too.

---

## Limitations

| Issue | Reason | Workaround |
|---|---|---|
| Colon-form `obj:method()` cross-file calls | Needs receiver type inference; Lua is dynamic | Grep or raw Cypher to find Method nodes by name |
| `setmetatable(__index)` inheritance | Runtime pattern, static analyser can't follow | — |
| Dynamic dispatch `obj[name]()` | Target unknown without runtime | — |
| LuaDoc annotations (`---@param`, `---@return`) | Not parsed | Future work |
| Simple-replace override (`function Obj.foo()` with no backup) | Cross-file symbol lookup not wired | Future work |

---

## Architecture

Key Lua-specific files (all under `gitnexus/src/core/ingestion/`):

| Concern | File |
|---|---|
| Language provider | `languages/lua.ts` |
| Tree-sitter queries | `tree-sitter-queries.ts` — `LUA_QUERIES` block |
| Export checker | `export-detection.ts` — `luaExportChecker` |
| Import resolver (`require`) | `import-resolvers/lua.ts` |
| Named binding (`local X = require(...)`) | `named-bindings/lua.ts` |
| Type extractor | `type-extractors/lua.ts` (no-op; Lua is untyped) |
| Entry-point patterns | `entry-point-scoring.ts` |
| Override detection script | `../../scripts/detect-lua-overrides.mjs` |

Shared registry (`gitnexus-shared/src/languages.ts` / `language-detection.ts`) registers Lua alongside other languages. Worker thread's language map (`workers/parse-worker.ts`) duplicates the main-thread loader — both need the Lua entry.

---

## Credits & License

This project is based on [GitNexus](https://github.com/abhigyanpatwari/GitNexus) by Abhigyan Patwari and contributors. All upstream commits are preserved in the git history.

**License:** PolyForm Noncommercial 1.0.0 — see [LICENSE](./LICENSE). Personal, educational, and non-commercial use only.
