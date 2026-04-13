/**
 * Lua type extractor — minimal/no-op.
 *
 * Lua has no static type system. Optional type hints via LuaDoc comments
 * (---@type, ---@param, ---@return) are not parsed in this MVP.
 *
 * The declarationNodeTypes set is kept minimal (just the common
 * declaration forms) so the generic pipeline walks them but extracts
 * nothing — parameters/variables land in the env untyped.
 */

import type { LanguageTypeConfig, TypeBindingExtractor, ParameterExtractor } from './types.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'variable_declaration',
  'assignment_statement',
  'function_declaration',
]);

const extractDeclaration: TypeBindingExtractor = (_node, _env) => {
  // Lua has no inline type annotations; nothing to extract for MVP.
};

const extractParameter: ParameterExtractor = (_node, _env) => {
  // Lua parameters carry no type annotations.
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
};
