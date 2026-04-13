/**
 * Lua language provider (MVP).
 *
 * Covers: function declarations, direct/method/member calls, require() imports.
 *
 * Not covered in this MVP (future work):
 *   - Metatable-based OOP / inheritance (setmetatable(__index=...))
 *   - Table-as-namespace heuristics (local M = {} + function M.foo)
 *   - LuaDoc type annotations (---@param, ---@return)
 *   - Dynamic dispatch (obj[varName]())
 *
 * Lua import semantics: `require` brings the whole module table into scope,
 * so 'wildcard' matches existing behavior for Ruby-like whole-module imports.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as luaTypeConfig } from '../type-extractors/lua.js';
import { luaExportChecker } from '../export-detection.js';
import { resolveLuaImport } from '../import-resolvers/lua.js';
import { extractLuaNamedBindings } from '../named-bindings/lua.js';
import { LUA_QUERIES } from '../tree-sitter-queries.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  // Basic
  'print',
  'tostring',
  'tonumber',
  'type',
  'pairs',
  'ipairs',
  'next',
  'select',
  'error',
  'assert',
  'pcall',
  'xpcall',
  'rawget',
  'rawset',
  'rawequal',
  'rawlen',
  'setmetatable',
  'getmetatable',
  'require',
  'dofile',
  'loadfile',
  'load',
  'loadstring',
  'unpack',
  // Standard libraries (used as callable prefixes)
  'string',
  'table',
  'math',
  'io',
  'os',
  'debug',
  'package',
  'bit32',
  'coroutine',
  // Common table methods captured as bare calls
  'insert',
  'remove',
  'concat',
  'sort',
  // Common string methods
  'format',
  'find',
  'match',
  'gmatch',
  'gsub',
  'sub',
  'len',
  'lower',
  'upper',
]);

export const luaProvider = defineLanguage({
  id: SupportedLanguages.Lua,
  extensions: ['.lua'],
  treeSitterQueries: LUA_QUERIES,
  typeConfig: luaTypeConfig,
  exportChecker: luaExportChecker,
  importResolver: resolveLuaImport,
  namedBindingExtractor: extractLuaNamedBindings,
  // Lua game-engine codebases (e.g. SmartPK-Mu) primarily use top-level global
  // declarations rather than require() — `Me = class(Player)` in Me.lua exposes
  // the global `Me` to every other Lua file at runtime. Combined with the
  // implicitImportWirer below, wildcard synthesis fans out exported symbols
  // from each Lua file into every other Lua file's import scope, which lets the
  // call-resolver find `Me.foo()`, `Role.bar()` etc. without any require().
  importSemantics: 'wildcard',
  /**
   * Lua has no static module system: globals are visible everywhere at runtime
   * (`Me` set up in unpack/.../Me.lua is callable from any other file). To
   * reflect that in the static graph we wire an implicit IMPORTS edge from
   * every Lua file to every other Lua file. The pipeline's namespace synthesis
   * then derives `<basename>` → `<file>` aliases, so `Receiver.method()` calls
   * can be resolved by looking up the file whose basename matches Receiver.
   *
   * Cost: O(n^2) in number of Lua files. For SmartPK-Mu (~1600 files) this is
   * ~2.5M edges — within graphology's comfort zone, and balanced by the much
   * better call-graph density we get back.
   */
  implicitImportWirer: (languageFiles, _importMap, addImportEdge) => {
    for (let i = 0; i < languageFiles.length; i++) {
      const src = languageFiles[i];
      for (let j = 0; j < languageFiles.length; j++) {
        if (i === j) continue;
        addImportEdge(src, languageFiles[j]);
      }
    }
  },
  builtInNames: BUILT_INS,
});
