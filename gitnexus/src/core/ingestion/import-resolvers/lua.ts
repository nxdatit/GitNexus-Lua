/**
 * Lua require() import resolution.
 *
 * Lua module paths use dots as path separators:
 *   require("foo.bar")       → foo/bar.lua  or foo/bar/init.lua
 *   require("foo/bar")       → foo/bar.lua  (slash form also seen)
 *   require "foo.bar"        → same (no parens)
 *
 * Suffix-matches against the project's file list (like Ruby).
 */

import { suffixResolve } from './utils.js';
import type { ImportResult, ResolveCtx } from './types.js';

/** Convert Lua module path into path segments. */
function toPathParts(importPath: string): string[] {
  // Allow both dot and slash separators. Strip leading './' if any.
  const normalized = importPath.replace(/^\.\//, '').replace(/\./g, '/');
  return normalized.split('/').filter(Boolean);
}

export function resolveLuaImport(
  rawImportPath: string,
  _filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const parts = toPathParts(rawImportPath);
  if (parts.length === 0) return null;
  const resolved = suffixResolve(parts, ctx.normalizedFileList, ctx.allFileList, ctx.index);
  return resolved ? { kind: 'files', files: [resolved] } : null;
}
