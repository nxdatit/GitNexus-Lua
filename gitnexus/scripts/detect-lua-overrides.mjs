#!/usr/bin/env node
/**
 * detect-lua-overrides.mjs
 *
 * Standalone post-process script for the GitNexus Lua fork.
 * Scans a project's Lua files for runtime override patterns and emits
 * METHOD_OVERRIDES edges to the knowledge graph.
 *
 * Runtime override patterns covered:
 *   1. Helper:  HvsMain:BackupFunc(Obj, "method")
 *   2. Helper:  HvsMain:ModifyFunc(Obj, "method", fn)
 *   3. Inline:  Obj.x_bak = Obj.x_bak or Obj.x      (suffix: _bak|_org|_backup|_origin)
 *              Obj.x     = function ... end
 *
 * NOT covered (out of MVP scope):
 *   4. Simple replace — `function Obj.foo() ... end` in user code that shadows
 *      an existing game-codebase method. Requires cross-file symbol lookup.
 *
 * Usage:
 *   cd <project_root>
 *   node G:/GitNexus/gitnexus/scripts/detect-lua-overrides.mjs [--dry-run] [--repo <name>]
 *
 * --dry-run (default): print candidates as JSON, no DB write
 * --repo <name>      : target repo name for the cypher MCP call (required when
 *                      multiple repos are indexed in the local registry)
 */

import Parser from 'tree-sitter';
import Lua from '@tree-sitter-grammars/tree-sitter-lua';
import lbug from '@ladybugdb/core';
import fs from 'node:fs/promises';
import path from 'node:path';

const CWD = process.cwd();
const ARGV = process.argv.slice(2);
const DRY_RUN = !ARGV.includes('--emit'); // default is dry-run
const REPO_IDX = ARGV.indexOf('--repo');
const REPO_NAME = REPO_IDX >= 0 ? ARGV[REPO_IDX + 1] : null;

const USER_CODE_PREFIXES = ['sources/', 'preloads/', 'adapters/', 'scripts/'];
const GAME_CODE_PREFIX = 'unpack/MU_Lua/';
const BACKUP_SUFFIXES = ['_bak', '_org', '_backup', '_origin'];
const HELPER_NAMES = new Set(['BackupFunc', 'ModifyFunc']);

// ── File discovery ──────────────────────────────────────────────────────────

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      await walk(full, out);
    } else if (e.isFile() && e.name.endsWith('.lua')) {
      out.push(full);
    }
  }
  return out;
}

function isUserCodeFile(relPath) {
  const posix = relPath.replace(/\\/g, '/');
  // Root-level .lua files count as user code too.
  if (!posix.includes('/')) return true;
  return USER_CODE_PREFIXES.some((p) => posix.startsWith(p));
}

// ── AST helpers ─────────────────────────────────────────────────────────────

function stripSuffix(fieldName) {
  for (const suf of BACKUP_SUFFIXES) {
    if (fieldName.endsWith(suf) && fieldName.length > suf.length) {
      return fieldName.slice(0, -suf.length);
    }
  }
  return null;
}

/**
 * Pattern 1+2: `HvsMain:BackupFunc(Obj, "method")` or `:ModifyFunc(Obj, "method", fn)`
 * AST shape:
 *   function_call
 *     name = method_index_expression { table=identifier, method=identifier }
 *     arguments = arguments { (, <target-identifier>, (string content=<name>), ... }
 */
function detectHelperCall(node, sourceFile, out) {
  if (node.type !== 'function_call') return;
  const name = node.childForFieldName?.('name');
  if (!name || name.type !== 'method_index_expression') return;
  const methodIdent = name.childForFieldName?.('method');
  if (!methodIdent || !HELPER_NAMES.has(methodIdent.text)) return;

  const args = node.childForFieldName?.('arguments');
  if (!args) return;

  // Walk named children, skipping syntactic '(' ')' ','
  const namedArgs = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c) namedArgs.push(c);
  }
  if (namedArgs.length < 2) return;

  const targetNode = namedArgs[0];
  const methodNameNode = namedArgs[1];

  // Target can be: identifier (e.g., CameraEffectMgr) or dot_index_expression (e.g., __H.xxx)
  let receiverText;
  if (targetNode.type === 'identifier') {
    receiverText = targetNode.text;
  } else if (targetNode.type === 'dot_index_expression') {
    // Use the final field as the receiver name (closest proxy to exported symbol)
    const field = targetNode.childForFieldName?.('field');
    receiverText = field?.text;
  }
  if (!receiverText) return;

  if (methodNameNode.type !== 'string') return;
  const stringContent = methodNameNode.namedChild(0);
  if (!stringContent || stringContent.type !== 'string_content') return;
  const methodName = stringContent.text;
  if (!methodName) return;

  out.push({
    pattern: 'helper',
    sourceFile,
    sourceLine: node.startPosition.row + 1,
    receiver: receiverText,
    method: methodName,
    helper: methodIdent.text,
    confidence: 0.9,
    reason: `runtime_override via HvsMain:${methodIdent.text}`,
  });
}

/**
 * Pattern 3: inline backup idiom
 *    Obj.field_bak = Obj.field_bak or Obj.field
 *    Obj.field     = function ... end
 * The assignment itself already tells us enough (receiver + field name) — we
 * don't strictly need to verify the next sibling is a function assignment.
 */
function detectInlineBackup(node, sourceFile, out) {
  if (node.type !== 'assignment_statement') return;

  // assignment_statement has no field names in tree-sitter-lua — positional
  // named children are [variable_list, expression_list].
  const varList = node.namedChild(0);
  const exprList = node.namedChild(1);
  if (!varList || varList.type !== 'variable_list') return;
  if (!exprList || exprList.type !== 'expression_list') return;

  const lhs = varList.namedChild(0);
  const rhs = exprList.namedChild(0);
  if (!lhs || !rhs) return;

  // LHS must be `X.field_bak` (or any suffix variant)
  if (lhs.type !== 'dot_index_expression') return;
  const lhsRecv = lhs.childForFieldName?.('table');
  const lhsField = lhs.childForFieldName?.('field');
  if (lhsRecv?.type !== 'identifier' || lhsField?.type !== 'identifier') return;
  const origField = stripSuffix(lhsField.text);
  if (!origField) return;

  // RHS must be `X.field_bak or X.field` — binary_expression with `or`
  if (rhs.type !== 'binary_expression') return;

  // Confirm the right branch of the `or` is `X.field` (unsuffixed) matching the LHS receiver
  const rhsRight = rhs.child(rhs.childCount - 1); // last child is right operand
  if (rhsRight?.type !== 'dot_index_expression') return;
  const rRecv = rhsRight.childForFieldName?.('table');
  const rField = rhsRight.childForFieldName?.('field');
  if (rRecv?.type !== 'identifier' || rField?.type !== 'identifier') return;
  if (rRecv.text !== lhsRecv.text) return;
  if (rField.text !== origField) return;

  out.push({
    pattern: 'inline',
    sourceFile,
    sourceLine: node.startPosition.row + 1,
    receiver: lhsRecv.text,
    method: origField,
    suffix: lhsField.text.slice(origField.length),
    confidence: 0.85,
    reason: `runtime_override via inline backup ${lhsField.text}`,
  });
}

function walkTree(node, visitor) {
  visitor(node);
  for (const child of node.children) walkTree(child, visitor);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.error(`[lua-overrides] scanning ${CWD} …`);
  const allLuaFiles = await walk(CWD);
  const userFiles = allLuaFiles.filter((f) => isUserCodeFile(path.relative(CWD, f)));
  console.error(
    `[lua-overrides] ${allLuaFiles.length} total Lua files, ${userFiles.length} in user-code paths`,
  );

  const parser = new Parser();
  parser.setLanguage(Lua);

  const candidates = [];
  let parseErrors = 0;

  for (const abs of userFiles) {
    const rel = path.relative(CWD, abs).replace(/\\/g, '/');
    let source;
    try {
      source = await fs.readFile(abs, 'utf-8');
    } catch {
      parseErrors++;
      continue;
    }
    let tree;
    try {
      tree = parser.parse(source, null, {
        bufferSize: Math.max(source.length * 2, 256 * 1024),
      });
    } catch (e) {
      parseErrors++;
      console.error(`[lua-overrides] parse failed: ${rel}: ${e.message}`);
      continue;
    }

    walkTree(tree.rootNode, (n) => {
      detectHelperCall(n, rel, candidates);
      detectInlineBackup(n, rel, candidates);
    });
  }

  console.error(
    `[lua-overrides] scan complete: ${candidates.length} candidate(s) (${parseErrors} parse errors)`,
  );

  if (DRY_RUN) {
    // Print candidates grouped by pattern
    const byPattern = {};
    for (const c of candidates) {
      byPattern[c.pattern] = (byPattern[c.pattern] || 0) + 1;
    }
    console.error(`[lua-overrides] by pattern:`, byPattern);
    process.stdout.write(JSON.stringify(candidates, null, 2));
    return;
  }

  // --emit mode: write directly to LadybugDB via @ladybugdb/core
  await emitToGraph(candidates);
}

async function emitToGraph(candidates) {
  const dbPath = path.join(CWD, '.gitnexus', 'lbug');
  console.error(`[lua-overrides] opening DB at ${dbPath} (read-write) …`);

  const db = new lbug.Database(dbPath);
  await db.init();
  const conn = new lbug.Connection(db);
  await conn.init();

  let emitted = 0;
  let skipped = 0;
  let ambiguous = 0;
  let dupes = 0;

  try {
    for (const c of candidates) {
      const target = await resolveTarget(conn, c);
      if (!target) {
        if (target === undefined) ambiguous++;
        else skipped++;
        continue;
      }

      const sourceUid = `File:${c.sourceFile}`;
      const reason = c.reason.replace(/'/g, "''");
      // LadybugDB rel CREATE needs explicit labels on both endpoints (multi-table FROM/TO).
      const tgtLabel = target.id.startsWith('Method:') ? 'Method' : 'Function';
      const createCypher = `
        MATCH (src:File), (tgt:${tgtLabel})
        WHERE src.id = '${sourceUid}' AND tgt.id = '${target.id.replace(/'/g, "''")}'
        CREATE (src)-[r:CodeRelation {
          type: 'METHOD_OVERRIDES',
          confidence: ${c.confidence},
          reason: '${reason}'
        }]->(tgt)
      `;
      try {
        await conn.query(createCypher);
        emitted++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Duplicate edge id → benign on re-runs
        if (msg.includes('duplicat') || msg.includes('PRIMARY KEY')) dupes++;
        else {
          console.error(`[emit] failed for ${sourceUid} → ${target.id}: ${msg.slice(0, 160)}`);
          skipped++;
        }
      }
    }
  } finally {
    await conn.close();
    await db.close();
  }

  console.error(
    `[lua-overrides] done: ${emitted} emitted, ${dupes} dupes, ${ambiguous} ambiguous, ${skipped} other-skipped`,
  );
}

async function resolveTarget(conn, candidate) {
  const methodEsc = candidate.method.replace(/'/g, "''");
  const q = `
    MATCH (n)
    WHERE (label(n) = 'Method' OR label(n) = 'Function')
      AND n.name = '${methodEsc}'
      AND n.filePath STARTS WITH '${GAME_CODE_PREFIX}'
    RETURN n.id AS id, n.filePath AS fp
    LIMIT 50
  `;
  let rows;
  try {
    const result = await conn.query(q);
    rows = await result.getAll();
  } catch (e) {
    console.error(`[resolve] query failed for ${candidate.method}: ${e.message?.slice(0, 100)}`);
    return null;
  }

  if (!rows || rows.length === 0) return null;
  const preferred = rows.find((r) => {
    const base = (r.fp || '').split('/').pop() || '';
    const stem = base.replace(/\.lua$/, '');
    return stem === candidate.receiver;
  });
  if (preferred) return preferred;
  if (rows.length === 1) return rows[0];
  return undefined; // ambiguous sentinel
}

main().catch((e) => {
  console.error('[lua-overrides] fatal:', e);
  process.exit(1);
});
