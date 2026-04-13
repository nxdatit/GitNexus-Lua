/**
 * Lua named-binding extractor.
 *
 * Lua import pattern:
 *     local X = require("foo.bar")     — local alias → module
 *     local X = require "foo.bar"      — bare string
 *     X      = require("foo.bar")      — global assignment (treated same)
 *
 * In tree-sitter-lua AST, the import query captures the `function_call`
 * node of `require(...)`. To extract the binding `X`, we walk up to the
 * enclosing `assignment_statement` / `variable_declaration` and read the
 * first variable in its variable_list.
 *
 * Lua uses `importSemantics: 'namespace'` — the local name X aliases to
 * the whole module, accessed as `X.foo()` / `X:bar()`. This matches
 * Python's `import mod as X` semantics, so we emit `isModuleAlias: true`.
 *
 * Patterns not covered in this MVP:
 *   - `local foo = require('m').foo`  (destructured member)
 *   - `local a, b = unpack(require('m'))` (multi-var destructure)
 *   - Chained: `local X = require('m'):init()`
 */

import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

const MAX_PARENT_DEPTH = 8;

export function extractLuaNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // importNode is the `function_call` of `require(...)`. Walk up looking
  // for the enclosing assignment_statement (which carries the local name).
  let current: SyntaxNode | null = importNode.parent;
  let depth = 0;
  let assignment: SyntaxNode | null = null;
  while (current && depth < MAX_PARENT_DEPTH) {
    if (current.type === 'assignment_statement') {
      assignment = current;
      break;
    }
    // Stop if we climb out of the expression context
    if (
      current.type === 'block' ||
      current.type === 'chunk' ||
      current.type === 'function_declaration'
    ) {
      break;
    }
    current = current.parent;
    depth++;
  }

  if (!assignment) return undefined;

  // Extract module path from require argument (string_content)
  const argsNode = importNode.childForFieldName?.('arguments');
  if (!argsNode) return undefined;
  const stringNode = findChild(argsNode, 'string');
  const contentNode = stringNode ? findChild(stringNode, 'string_content') : null;
  const modulePath = contentNode?.text;
  if (!modulePath) return undefined;

  // Get first identifier from the LHS variable_list
  const varList = findChild(assignment, 'variable_list');
  if (!varList) return undefined;
  const localIdent = findChild(varList, 'identifier');
  const localName = localIdent?.text;
  if (!localName) return undefined;

  // Only handle the single-var form: `local X = require(...)` or `X = require(...)`
  // Skip destructuring like `local a, b = ...` (variable_list has > 1 identifier).
  let identCount = 0;
  for (let i = 0; i < varList.namedChildCount; i++) {
    if (varList.namedChild(i)?.type === 'identifier') identCount++;
  }
  if (identCount !== 1) return undefined;

  return [
    {
      local: localName,
      exported: modulePath,
      isModuleAlias: true,
    },
  ];
}
