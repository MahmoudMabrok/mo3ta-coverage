import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// =============================================================================
// AST -> import specifiers
// =============================================================================

function inferScriptKind(filePath) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (
    filePath.endsWith('.js') ||
    filePath.endsWith('.mjs') ||
    filePath.endsWith('.cjs')
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function getImportSpecifiers(filePath, opts) {
  let sourceCode;
  try {
    sourceCode = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    inferScriptKind(filePath)
  );

  const specifiers = [];

  function visit(node) {
    // import ... from '...'
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    // export ... from '...'
    else if (
      opts.includeReExports &&
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    // import('...') dynamic
    else if (
      opts.includeDynamicImports &&
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    // require('...')
    else if (
      opts.includeDynamicImports &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

// =============================================================================
// tsconfig + module resolution
// =============================================================================

function loadCompilerOptions(projectDir, tsconfigPath) {
  const configPath =
    tsconfigPath ||
    ts.findConfigFile(projectDir, ts.sys.fileExists, 'tsconfig.json');

  if (!configPath) {
    return {
      options: { allowJs: true, esModuleInterop: true },
      configDir: path.resolve(projectDir),
    };
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(
        configFile.error.messageText,
        '\n'
      )}`
    );
  }

  const configDir = path.dirname(path.resolve(configPath));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);

  return {
    options: Object.assign({ allowJs: true }, parsed.options),
    configDir,
  };
}

function resolveImport(specifier, containingFile, options, host, cache) {
  const result = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host,
    cache
  );

  const resolved = result.resolvedModule;
  if (!resolved) return null;
  if (resolved.isExternalLibraryImport) return null;       // skip node_modules
  if (resolved.extension === ts.Extension.Dts) return null; // skip .d.ts
  return path.resolve(resolved.resolvedFileName);
}

// =============================================================================
// File walking
// =============================================================================

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', 'coverage'];

function findSourceFiles(rootDir, extensions, ignore) {
  const out = [];
  const absRoot = path.resolve(rootDir);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (ignore.some((pat) => full.includes(pat))) continue;

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.d.ts')) continue;
        if (extensions.some((ext) => entry.name.endsWith(ext))) {
          out.push(full);
        }
      }
    }
  }

  walk(absRoot);
  return out;
}

// =============================================================================
// Build the reverse-dependency graph
// =============================================================================

/**
 * @typedef {Object} ImporterGraphOptions
 * @property {string} projectDir
 * @property {string} [tsconfigPath]
 * @property {string[]} [extensions]
 * @property {string[]} [ignore]
 * @property {boolean} [includeReExports]
 * @property {boolean} [includeDynamicImports]
 */

/**
 * @typedef {Object} ReverseGraph
 * @property {Map<string, Set<string>>} edges  file -> direct importers
 * @property {string[]} allFiles
 */

/**
 * @param {ImporterGraphOptions} opts
 * @returns {ReverseGraph}
 */
export function buildReverseGraph(opts) {
  const {
    projectDir,
    tsconfigPath,
    extensions = DEFAULT_EXTENSIONS,
    ignore = DEFAULT_IGNORE,
    includeReExports = true,
    includeDynamicImports = true,
  } = opts;

  const { options, configDir } = loadCompilerOptions(projectDir, tsconfigPath);
  const host = ts.createCompilerHost(options, /* setParentNodes */ true);
  const cache = ts.createModuleResolutionCache(configDir, (s) => s, options);

  const allFiles = findSourceFiles(projectDir, extensions, ignore);
  const edges = new Map();

  const specOpts = { includeReExports, includeDynamicImports };

  for (const file of allFiles) {
    const specifiers = getImportSpecifiers(file, specOpts);
    for (const spec of specifiers) {
      const resolved = resolveImport(spec, file, options, host, cache);
      if (!resolved) continue;
      let importers = edges.get(resolved);
      if (!importers) {
        importers = new Set();
        edges.set(resolved, importers);
      }
      importers.add(file);
    }
  }

  return { edges, allFiles };
}

// =============================================================================
// Main API: find importers up to a max depth (BFS)
// =============================================================================

/**
 * @typedef {Object} ImporterNode
 * @property {string} file
 * @property {number} depth
 * @property {string} [importedBy]
 */

/**
 * @typedef {Object} FindImportersResult
 * @property {string} target
 * @property {ImporterNode[]} importers
 * @property {number} maxDepthReached
 */

/**
 * @param {string} targetFile
 * @param {number} maxDepth
 * @param {ReverseGraph} graph
 * @returns {FindImportersResult}
 */
export function findImportersWithDepth(targetFile, maxDepth, graph) {
  if (maxDepth < 1) {
    throw new Error(`maxDepth must be >= 1, got ${maxDepth}`);
  }

  const target = path.resolve(targetFile);
  const visited = new Map(); // file -> ImporterNode
  const queue = [{ file: target, depth: 0, importedBy: undefined }];
  let maxDepthReached = 0;

  while (queue.length > 0) {
    const { file, depth, importedBy } = queue.shift();

    if (visited.has(file)) continue;

    if (file !== target) {
      visited.set(file, { file, depth, importedBy });
      if (depth > maxDepthReached) maxDepthReached = depth;
    }

    if (depth >= maxDepth) continue;

    const directImporters = graph.edges.get(file);
    if (!directImporters) continue;

    for (const importer of directImporters) {
      if (!visited.has(importer) && importer !== target) {
        queue.push({ file: importer, depth: depth + 1, importedBy: file });
      }
    }
  }

  const importers = Array.from(visited.values()).sort(
    (a, b) => a.depth - b.depth || a.file.localeCompare(b.file)
  );

  return { target, importers, maxDepthReached };
}

/**
 * Convenience: build graph + query in one call.
 * @param {string} targetFile
 * @param {number} maxDepth
 * @param {ImporterGraphOptions} opts
 * @returns {FindImportersResult}
 */
export function findImporters(targetFile, maxDepth, opts) {
  const graph = buildReverseGraph(opts);
  return findImportersWithDepth(targetFile, maxDepth, graph);
}

/**
 * Convenience: query many targets against the same graph.
 * @param {string[]} targets
 * @param {number} maxDepth
 * @param {ImporterGraphOptions} opts
 * @returns {Map<string, FindImportersResult>}
 */
export function findImportersForMany(targets, maxDepth, opts) {
  const graph = buildReverseGraph(opts);
  const results = new Map();
  for (const t of targets) {
    results.set(path.resolve(t), findImportersWithDepth(t, maxDepth, graph));
  }
  return results;
}