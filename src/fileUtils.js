import fs from 'fs';
import path from 'path';

const TEST_FILE_RE = /(\.test|\.spec)\.(js|ts|jsx|tsx)$/;
const JS_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];
const KNOWN_MODULE_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo']);
const TSCONFIG_FILENAMES = ['tsconfig.base.json', 'tsconfig.json', 'jsconfig.json'];
const EXPORT_CONDITION_PRIORITY = ['source', 'development', 'import', 'default', 'require', 'browser', 'node'];

// Matches import/require specifiers in JS/TS files:
//   import x from './mod'; import './mod'; export { x } from './mod';
//   require('./mod'); require.resolve('./mod'); await import('./mod');
//   jest.mock('./mod'); jest.doMock('./mod'); jest.unmock('./mod');
//   jest.requireActual('./mod'); jest.requireMock('./mod');
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s+|\brequire(?:\.resolve)?\s*\(\s*|\bimport\s*\(\s*|\bimport\s+|\bjest\.(?:mock|doMock|unmock|requireActual|requireMock)\s*\(\s*)['"]([^'"\n]+)['"]/g;

export function getJsOnlyFiles(files, runTestsOnly) {
  // Only include source code files, exclude test, config, and json files
  return files.filter(f => {
    // Exclude test files
    if (f.match(/(\.test|\.spec)\.(js|ts|jsx|tsx)$/)) return false || runTestsOnly;
    // skip non test files when running only test files
    if (runTestsOnly) return false;
    // Exclude config files and files with .config. in their name
    if (f.match(/(jest|babel|webpack|tsconfig|eslint|prettier|rollup|vite|package)\.(js|ts|json)$/) || f.includes('.config.')) return false;
    // Exclude json files
    if (f.endsWith('.json')) return false;
    // Only include code files
    return f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.jsx') || f.endsWith('.tsx');
  });
}

/**
 * Separates files into source files and test files
 * @param {string[]} files - Array of file paths
 * @returns {{sourceFiles: string[], testFiles: string[]}}
 */
export function separateSourceAndTestFiles(files) {
  const sourceFiles = [];
  const testFiles = [];

  files.forEach(file => {
    // Exclude config files
    if (file.match(/(jest|babel|webpack|tsconfig|eslint|prettier|rollup|vite|package)\.(js|ts|json)$/) || file.includes('.config.')) {
      return;
    }
    // Exclude json files
    if (file.endsWith('.json')) {
      return;
    }

    // Check if it's a test file
    if (file.match(/(\.test|\.spec)\.(js|ts|jsx|tsx)$/)) {
      testFiles.push(file);
    } else if (file.match(/\.(js|ts|jsx|tsx)$/)) {
      sourceFiles.push(file);
    }
  });

  return { sourceFiles, testFiles };
}

/**
 * Builds candidate test paths for a source file using common naming conventions.
 * Paths are relative and have not been checked against the filesystem.
 * @param {string} sourceFile - Path to source file (relative)
 * @returns {string[]} - Candidate test file paths
 */
function getTestFileCandidates(sourceFile) {
  const testFiles = [];
  const parsed = path.parse(sourceFile);
  const extensions = ['.js', '.ts', '.jsx', '.tsx'];

  // Pattern 1: Same directory with .test or .spec suffix
  // e.g., src/utils/helper.js → src/utils/helper.test.js
  extensions.forEach(ext => {
    testFiles.push(path.join(parsed.dir, `${parsed.name}.test${ext}`));
    testFiles.push(path.join(parsed.dir, `${parsed.name}.spec${ext}`));
  });

  // Pattern 2: __tests__ subdirectory
  // e.g., src/utils/helper.js → src/utils/__tests__/helper.test.js
  extensions.forEach(ext => {
    testFiles.push(path.join(parsed.dir, '__tests__', `${parsed.name}.test${ext}`));
    testFiles.push(path.join(parsed.dir, '__tests__', `${parsed.name}.spec${ext}`));
    testFiles.push(path.join(parsed.dir, '__tests__', `${parsed.name}${ext}`));
  });

  // Pattern 3: tests directory at same level
  // e.g., src/utils/helper.js → src/tests/utils/helper.test.js
  const srcMatch = sourceFile.match(/^(.*?\/src)\/(.*)/);
  if (srcMatch) {
    const baseDir = srcMatch[1];
    const relativePath = srcMatch[2];
    const relParsed = path.parse(relativePath);

    extensions.forEach(ext => {
      testFiles.push(path.join(baseDir, 'tests', relParsed.dir, `${relParsed.name}.test${ext}`));
      testFiles.push(path.join(baseDir, 'tests', relParsed.dir, `${relParsed.name}.spec${ext}`));
    });
  }

  return testFiles;
}

/**
 * Finds potential test files for a given source file
 * Checks multiple naming conventions and locations
 * @param {string} sourceFile - Path to source file
 * @returns {string[]} - Array of potential test file paths
 */
export function findTestFilesForSource(sourceFile, root = process.cwd()) {
  const candidates = getTestFileCandidates(sourceFile);
  // The default (cwd) path stays relative. Callers and tests observe the
  // exact path strings passed to existsSync; resolving them would change that.
  if (path.resolve(root) === process.cwd()) {
    return candidates.filter(testFile => fs.existsSync(testFile));
  }
  return candidates.filter(testFile => fs.existsSync(path.resolve(root, testFile)));
}

/**
 * Drops cached directory walks and monorepo resolution indexes. The CLI keeps
 * the cache for one process; long-running callers (the MCP server) clear it
 * between tool calls.
 */
export function clearScanCaches() {
  cachedAllTestFiles = null;
  cachedAllJsFiles = null;
  cachedReverseImportIndex = null;
  cachedResolverContext = null;
}

/**
 * Root-aware variant of findTestFilesForSource used by the import graph walker.
 * Existence is checked relative to `root`, while returned paths stay relative.
 * @param {string} sourceFile - Path to source file relative to root
 * @param {string} root - Directory the paths are relative to
 * @returns {string[]} - Existing test file paths relative to root
 */
function findTestFilesForSourceInRoot(sourceFile, root) {
  return getTestFileCandidates(sourceFile)
    .filter(testFile => fs.existsSync(path.resolve(root, testFile)));
}

let cachedAllTestFiles = null;

/**
 * Collects every test file under the given root (relative to that root),
 * skipping dependency/build directories.
 * Results are cached per root for the lifetime of the CLI run.
 * @param {string} [root] - Directory to scan (defaults to cwd)
 * @returns {string[]} - Array of test file paths relative to root
 */
export function findAllTestFiles(root = process.cwd()) {
  if (cachedAllTestFiles && cachedAllTestFiles.root === root) {
    return cachedAllTestFiles.files;
  }

  const results = [];
  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.forEach(entry => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(fullPath);
        }
      } else if (TEST_FILE_RE.test(entry.name)) {
        results.push(path.relative(root, fullPath));
      }
    });
  };

  walk(root);
  cachedAllTestFiles = { root, files: results };
  return results;
}

/**
 * Extracts quoted module specifiers from import/require statements.
 * @param {string} content - File content
 * @returns {string[]} - Unique specifiers
 */
function extractImportSpecifiers(content) {
  const specifiers = new Set();
  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    if (match[1]) specifiers.add(match[1]);
  }
  return Array.from(specifiers);
}

function isExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a base file path (with or without extension) to existing module files.
 * Handles TypeScript ESM convention ('.js' -> '.ts'/'.tsx'), dotted file stems
 * (e.g. './auth.service' -> './auth.service.ts'), and directory index files.
 * @param {string} base
 * @param {Set<string>|null} [existingFilesSet]
 * @returns {string[]}
 */
function resolveFilePathCandidates(base, existingFilesSet = null) {
  const ext = path.extname(base);
  const candidates = [];

  if (KNOWN_MODULE_EXTENSIONS.has(ext)) {
    candidates.push(base);
    const stem = base.slice(0, -ext.length);
    if (ext === '.js' || ext === '.jsx') {
      candidates.push(`${stem}.ts`, `${stem}.tsx`);
    } else if (ext === '.mjs') {
      candidates.push(`${stem}.mts`, `${stem}.ts`);
    } else if (ext === '.cjs') {
      candidates.push(`${stem}.cts`, `${stem}.ts`);
    }
  } else {
    if (ext) {
      candidates.push(base);
    }
    JS_EXTENSIONS.forEach(e => candidates.push(base + e));
    JS_EXTENSIONS.forEach(e => candidates.push(path.join(base, `index${e}`)));
  }

  const matches = [];
  const seen = new Set();
  candidates.forEach(candidate => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return;
    const exists = existingFilesSet ? existingFilesSet.has(resolved) : isExistingFile(resolved);
    if (exists) {
      seen.add(resolved);
      matches.push(resolved);
    }
  });

  return matches;
}

/**
 * Resolves a relative specifier ('./mod', '../src/mod', './auth.service') to existing file paths.
 * @param {string} specifier
 * @param {string} fromDir
 * @param {Set<string>|null} [existingFilesSet]
 * @returns {string[]}
 */
function resolveSpecifierCandidates(specifier, fromDir, existingFilesSet = null) {
  return resolveFilePathCandidates(path.resolve(fromDir, specifier), existingFilesSet);
}

/**
 * Parses JSON with // and /* comments and trailing commas while preserving
 * comment-like sequences (such as "@app/*": ["src/*"]) inside string literals.
 * @param {string} raw
 * @returns {unknown}
 */
function parseJsonc(raw) {
  const withoutComments = String(raw).replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    match => (match.startsWith('"') ? match : '')
  );
  const withoutTrailingCommas = withoutComments.replace(
    /"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g,
    match => (match.startsWith('"') ? match : '')
  );
  return JSON.parse(withoutTrailingCommas);
}

function readJsoncFile(filePath) {
  try {
    return parseJsonc(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveExtendsPath(extSpec, configDir) {
  if (typeof extSpec !== 'string' || (!extSpec.startsWith('.') && !path.isAbsolute(extSpec))) {
    return null;
  }
  const direct = path.resolve(configDir, extSpec);
  if (isExistingFile(direct)) return direct;
  if (!extSpec.endsWith('.json')) {
    const withJson = `${direct}.json`;
    if (isExistingFile(withJson)) return withJson;
  }
  return null;
}

/**
 * Parses a tsconfig/jsconfig file and its relative `extends` chain.
 * Rules carry the `baseDir` of the config that defined them so child configs
 * can define local `@/*` without breaking inherited monorepo paths.
 */
function loadTsConfigChain(configPath, parsedCache, seen = new Set()) {
  const resolvedPath = path.resolve(configPath);
  if (parsedCache.has(resolvedPath)) return parsedCache.get(resolvedPath);
  if (seen.has(resolvedPath) || !isExistingFile(resolvedPath)) return null;

  seen.add(resolvedPath);
  const parsed = readJsoncFile(resolvedPath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsedCache.set(resolvedPath, null);
    return null;
  }

  const configDir = path.dirname(resolvedPath);
  const extendsList = Array.isArray(parsed.extends)
    ? parsed.extends
    : (typeof parsed.extends === 'string' ? [parsed.extends] : []);

  let inheritedBaseUrl = null;
  const baseDirs = [];
  const rulesByPattern = new Map();

  extendsList.forEach(extSpec => {
    const parentPath = resolveExtendsPath(extSpec, configDir);
    if (!parentPath) return;
    const parent = loadTsConfigChain(parentPath, parsedCache, seen);
    if (!parent) return;

    if (parent.baseUrl) inheritedBaseUrl = parent.baseUrl;
    parent.baseDirs.forEach(dir => {
      if (!baseDirs.includes(dir)) baseDirs.push(dir);
    });
    parent.rulesByPattern.forEach((rule, pattern) => {
      rulesByPattern.set(pattern, rule);
    });
  });

  const compilerOptions = parsed.compilerOptions && typeof parsed.compilerOptions === 'object'
    ? parsed.compilerOptions
    : {};
  const ownBaseUrl = typeof compilerOptions.baseUrl === 'string' && compilerOptions.baseUrl.trim()
    ? path.resolve(configDir, compilerOptions.baseUrl)
    : null;
  const effectiveBaseUrl = ownBaseUrl || inheritedBaseUrl;

  if (ownBaseUrl && !baseDirs.includes(ownBaseUrl)) {
    baseDirs.unshift(ownBaseUrl);
  }

  const rawPaths = compilerOptions.paths;
  if (rawPaths && typeof rawPaths === 'object' && !Array.isArray(rawPaths)) {
    const ruleBaseDir = ownBaseUrl || inheritedBaseUrl || configDir;
    Object.entries(rawPaths).forEach(([pattern, targets]) => {
      if (!Array.isArray(targets) || targets.length === 0) return;
      const starIdx = pattern.indexOf('*');
      const hasWildcard = starIdx !== -1;
      const prefix = hasWildcard ? pattern.slice(0, starIdx) : pattern;
      const suffix = hasWildcard ? pattern.slice(starIdx + 1) : '';
      rulesByPattern.set(pattern, {
        pattern,
        prefix,
        suffix,
        hasWildcard,
        targets: targets.filter(target => typeof target === 'string' && target.trim().length > 0),
        baseDir: ruleBaseDir
      });
    });
  }

  const result = { baseUrl: effectiveBaseUrl, baseDirs, rulesByPattern };
  parsedCache.set(resolvedPath, result);
  return result;
}

function sortPathRules(rules) {
  return [...rules].sort((a, b) => {
    if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
    if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
    return b.suffix.length - a.suffix.length;
  });
}

/**
 * Builds a directory-aware tsconfig/jsconfig path resolver rooted at `root`.
 */
function createTsConfigResolver(root) {
  const resolvedRoot = path.resolve(root);
  const parsedCache = new Map();
  const dirConfigCache = new Map();

  function getConfigForDir(dir) {
    const startDir = path.resolve(dir);
    if (dirConfigCache.has(startDir)) return dirConfigCache.get(startDir);

    // Collect directories from startDir up to resolvedRoot, then merge root -> leaf
    // so closer configs override parent/root patterns while still inheriting root paths.
    const chainDirs = [];
    let current = startDir;
    while (true) {
      chainDirs.push(current);
      if (current === resolvedRoot) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    chainDirs.reverse();

    const rulesByPattern = new Map();
    const baseDirs = [];

    chainDirs.forEach(chainDir => {
      TSCONFIG_FILENAMES.forEach(filename => {
        const cfg = loadTsConfigChain(path.join(chainDir, filename), parsedCache);
        if (!cfg) return;
        cfg.rulesByPattern.forEach((rule, pattern) => {
          rulesByPattern.set(pattern, rule);
        });
        cfg.baseDirs.forEach(baseDir => {
          if (!baseDirs.includes(baseDir)) baseDirs.unshift(baseDir);
        });
      });
    });

    const resolved = {
      rules: sortPathRules(rulesByPattern.values()),
      baseDirs
    };
    dirConfigCache.set(startDir, resolved);
    return resolved;
  }

  return function resolveWithTsConfig(specifier, fromFile, existingFilesSet) {
    const fromDir = path.dirname(path.resolve(resolvedRoot, fromFile));
    const { rules, baseDirs } = getConfigForDir(fromDir);
    const matches = [];
    const seen = new Set();

    const addCandidates = candidateBase => {
      resolveFilePathCandidates(candidateBase, existingFilesSet).forEach(file => {
        if (!seen.has(file)) {
          seen.add(file);
          matches.push(file);
        }
      });
    };

    for (const rule of rules) {
      let matchedWildcard = '';
      if (!rule.hasWildcard) {
        if (specifier !== rule.pattern) continue;
      } else {
        if (
          specifier.length < rule.prefix.length + rule.suffix.length ||
          !specifier.startsWith(rule.prefix) ||
          !specifier.endsWith(rule.suffix)
        ) {
          continue;
        }
        matchedWildcard = specifier.slice(rule.prefix.length, specifier.length - rule.suffix.length);
      }

      rule.targets.forEach(target => {
        const expanded = rule.hasWildcard ? target.replace('*', matchedWildcard) : target;
        addCandidates(path.resolve(rule.baseDir, expanded));
      });

      if (matches.length > 0) return matches;
    }

    for (const baseDir of baseDirs) {
      addCandidates(path.resolve(baseDir, specifier));
    }

    return matches;
  };
}

/**
 * Walks `root` (skipping SKIP_DIRS and dot-directories) and indexes workspace
 * package.json files by `pkg.name`.
 */
function buildWorkspacePackageIndex(root) {
  const packages = new Map();

  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.forEach(entry => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(fullPath);
        }
      } else if (entry.name === 'package.json') {
        try {
          const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) {
            const name = pkg.name.trim();
            if (!packages.has(name)) packages.set(name, []);
            packages.get(name).push({ dir, pkg });
          }
        } catch {
          // Ignore malformed package.json files
        }
      }
    });
  };

  walk(root);
  return packages;
}

function parsePackageSpecifier(specifier) {
  const normalized = specifier.replace(/\\/g, '/');
  if (normalized.startsWith('@')) {
    const parts = normalized.split('/');
    if (parts.length < 2 || !parts[1]) return null;
    return {
      pkgName: `${parts[0]}/${parts[1]}`,
      subpath: parts.slice(2).join('/')
    };
  }
  const slashIdx = normalized.indexOf('/');
  if (slashIdx === -1) {
    return { pkgName: normalized, subpath: '' };
  }
  return {
    pkgName: normalized.slice(0, slashIdx),
    subpath: normalized.slice(slashIdx + 1)
  };
}

function extractExportTargets(node, targets = []) {
  if (typeof node === 'string') {
    if (!node.startsWith('!')) targets.push(node);
    return targets;
  }
  if (Array.isArray(node)) {
    node.forEach(item => extractExportTargets(item, targets));
    return targets;
  }
  if (node && typeof node === 'object') {
    const visited = new Set();
    EXPORT_CONDITION_PRIORITY.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        visited.add(key);
        extractExportTargets(node[key], targets);
      }
    });
    Object.keys(node).forEach(key => {
      if (visited.has(key) || key === 'types' || key.startsWith('.')) return;
      extractExportTargets(node[key], targets);
    });
  }
  return targets;
}

function withDistBuildSourceCounterparts(targets) {
  const expanded = [];
  const seen = new Set();
  const add = target => {
    if (typeof target !== 'string' || !target.trim() || target.startsWith('!')) return;
    if (!seen.has(target)) {
      seen.add(target);
      expanded.push(target);
    }
  };

  targets.forEach(target => {
    add(target);
    const cleaned = target.replace(/^\.\//, '');
    if (cleaned.startsWith('dist/')) {
      add(`src/${cleaned.slice('dist/'.length)}`);
    } else if (cleaned.startsWith('build/')) {
      add(`src/${cleaned.slice('build/'.length)}`);
    }
  });

  return expanded;
}

/**
 * Resolves a workspace package import (e.g. '@org/shared', '@org/shared/utils')
 * using package.json exports/source/module/main and conventional entrypoints.
 */
function resolveWorkspacePackageSpecifier(specifier, workspacePackages, existingFilesSet) {
  if (workspacePackages.size === 0) return [];
  const parsed = parsePackageSpecifier(specifier);
  if (!parsed) return [];

  const entries = workspacePackages.get(parsed.pkgName);
  if (!entries || entries.length === 0) return [];

  const matches = [];
  const seen = new Set();

  entries.forEach(({ dir, pkg }) => {
    const rawTargets = [];

    if (!parsed.subpath) {
      if (typeof pkg.exports === 'string' || Array.isArray(pkg.exports)) {
        extractExportTargets(pkg.exports, rawTargets);
      } else if (pkg.exports && typeof pkg.exports === 'object') {
        if (Object.prototype.hasOwnProperty.call(pkg.exports, '.')) {
          extractExportTargets(pkg.exports['.'], rawTargets);
        } else if (!Object.keys(pkg.exports).some(key => key.startsWith('.'))) {
          extractExportTargets(pkg.exports, rawTargets);
        }
      }
      if (typeof pkg.source === 'string') rawTargets.push(pkg.source);
      if (typeof pkg.module === 'string') rawTargets.push(pkg.module);
      if (typeof pkg.main === 'string') rawTargets.push(pkg.main);
      rawTargets.push('src/index', 'index');
    } else {
      const exportKey = `./${parsed.subpath}`;
      if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
        if (Object.prototype.hasOwnProperty.call(pkg.exports, exportKey)) {
          extractExportTargets(pkg.exports[exportKey], rawTargets);
        }
        Object.entries(pkg.exports).forEach(([key, value]) => {
          if (!key.startsWith('./') || !key.includes('*')) return;
          const starIdx = key.indexOf('*');
          const prefix = key.slice(0, starIdx);
          const suffix = key.slice(starIdx + 1);
          if (
            exportKey.length >= prefix.length + suffix.length &&
            exportKey.startsWith(prefix) &&
            exportKey.endsWith(suffix)
          ) {
            const matched = exportKey.slice(prefix.length, exportKey.length - suffix.length);
            extractExportTargets(value, []).forEach(target => {
              rawTargets.push(target.replace('*', matched));
            });
          }
        });
      }
      rawTargets.push(parsed.subpath, `src/${parsed.subpath}`);
    }

    withDistBuildSourceCounterparts(rawTargets).forEach(target => {
      resolveFilePathCandidates(path.resolve(dir, target), existingFilesSet).forEach(file => {
        if (!seen.has(file)) {
          seen.add(file);
          matches.push(file);
        }
      });
    });
  });

  return matches;
}

/**
 * Finds test files that import the given source file, regardless of
 * the test file's naming convention. Uses the same relative, tsconfig/jsconfig,
 * workspace package, and alias resolution as smart mode.
 * @param {string} sourceFile - Path to source file (relative to root)
 * @param {string} [root] - Directory to scan for test files (defaults to cwd)
 * @returns {string[]} - Array of test file paths (relative to root) that import the source file
 */
export function findTestFilesByImport(sourceFile, root = process.cwd()) {
  const resolvedSource = path.resolve(root, sourceFile);
  const context = getResolverContext(root);
  const matching = [];

  for (const testFile of findAllTestFiles(root)) {
    let content;
    try {
      content = fs.readFileSync(path.resolve(root, testFile), 'utf8');
    } catch {
      continue;
    }

    const specifiers = extractImportSpecifiers(content);
    const matched = specifiers.some(specifier =>
      resolveImportTargets(specifier, testFile, root, context).includes(resolvedSource)
    );

    if (matched) {
      matching.push(testFile);
    }
  }

  return matching;
}

let cachedAllJsFiles = null;

/**
 * Collects every JS/TS file under the given root, skipping dependency/build
 * directories. Results are cached per root for the lifetime of the CLI run.
 * @param {string} [root] - Directory to scan (defaults to cwd)
 * @returns {string[]} - File paths relative to root
 */
export function findAllJsFiles(root = process.cwd()) {
  if (cachedAllJsFiles && cachedAllJsFiles.root === root) {
    return cachedAllJsFiles.files;
  }

  const results = [];
  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.forEach(entry => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(fullPath);
        }
      } else if (JS_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
        results.push(path.relative(root, fullPath));
      }
    });
  };

  walk(root);
  cachedAllJsFiles = { root, files: results };
  return results;
}

function isTestFile(filePath) {
  return TEST_FILE_RE.test(filePath);
}

function stripJsExtension(filePath) {
  return filePath.replace(/\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/, '');
}

/**
 * Builds a lookup of repo-relative paths without extensions. Multiple files can
 * share a path stem when they use different extensions (e.g. helper.js/.ts).
 */
function buildNoExtIndex(files) {
  const index = new Map();
  files.forEach(file => {
    const normalized = file.replace(/\\/g, '/');
    const key = stripJsExtension(normalized);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(file);
  });
  return index;
}

function matchNoExtIndex(stem, root, noExtIndex) {
  if (!stem) return [];

  const matches = [];
  const seen = new Set();
  const addFiles = files => {
    if (!files) return;
    files.forEach(file => {
      const resolved = path.resolve(root, file);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        matches.push(resolved);
      }
    });
  };

  addFiles(noExtIndex.get(stem));
  addFiles(noExtIndex.get(`${stem}/index`));
  if (matches.length > 0) return matches;

  const suffix = `/${stem}`;
  const indexSuffix = `/${stem}/index`;
  for (const [key, files] of noExtIndex) {
    if (key.endsWith(suffix) || key.endsWith(indexSuffix)) {
      addFiles(files);
    }
  }
  return matches;
}

/**
 * Heuristic fallback for non-relative specifiers when tsconfig/jsconfig and
 * workspace package.json resolution find no matches.
 * Checks exact stem, stem/index, path-suffix, and suffix/index matches.
 */
function resolveNonRelativeSpecifier(specifier, root, noExtIndex) {
  let stem = stripJsExtension(specifier).replace(/\\/g, '/');
  if (!stem) return [];

  if (stem.startsWith('@/') || stem.startsWith('~/')) {
    return matchNoExtIndex(stem.slice(2), root, noExtIndex);
  }

  const direct = matchNoExtIndex(stem, root, noExtIndex);
  if (direct.length > 0) return direct;

  if (stem.startsWith('@') && stem.includes('/')) {
    return matchNoExtIndex(stem.slice(1), root, noExtIndex);
  }

  return [];
}

let cachedResolverContext = null;

function getResolverContext(root) {
  if (cachedResolverContext && cachedResolverContext.root === root) {
    return cachedResolverContext.context;
  }

  const files = findAllJsFiles(root);
  const existingFilesSet = new Set(files.map(file => path.resolve(root, file)));
  const context = {
    noExtIndex: buildNoExtIndex(files),
    existingFilesSet,
    resolveWithTsConfig: createTsConfigResolver(root),
    workspacePackages: buildWorkspacePackageIndex(root)
  };
  cachedResolverContext = { root, context };
  return context;
}

/**
 * Resolves an import specifier found in `fromFile` to absolute file paths.
 * Relative specifiers resolve against the importing file's directory;
 * non-relative specifiers resolve via tsconfig/jsconfig paths & baseUrl,
 * workspace package.json entrypoints, then heuristic path/alias matching.
 */
function resolveImportTargets(specifier, fromFile, root, context) {
  if (specifier.startsWith('.')) {
    const fromDir = path.dirname(path.resolve(root, fromFile));
    return resolveSpecifierCandidates(specifier, fromDir, context.existingFilesSet);
  }

  const tsMatches = context.resolveWithTsConfig(specifier, fromFile, context.existingFilesSet);
  if (tsMatches.length > 0) return tsMatches;

  const pkgMatches = resolveWorkspacePackageSpecifier(
    specifier,
    context.workspacePackages,
    context.existingFilesSet
  );
  if (pkgMatches.length > 0) return pkgMatches;

  return resolveNonRelativeSpecifier(specifier, root, context.noExtIndex);
}

let cachedReverseImportIndex = null;

/**
 * Builds (and caches per root) a reverse import index:
 *   absolute module path → Set of absolute paths that import it.
 * All JS/TS files participate, so traversal can pass through intermediate
 * modules such as barrel files.
 * @param {string} [root] - Directory to scan (defaults to cwd)
 * @returns {Map<string, Set<string>>}
 */
export function buildReverseImportIndex(root = process.cwd()) {
  if (cachedReverseImportIndex && cachedReverseImportIndex.root === root) {
    return cachedReverseImportIndex.index;
  }

  const files = findAllJsFiles(root);
  const context = getResolverContext(root);
  const index = new Map();

  files.forEach(relFile => {
    let content;
    try {
      content = fs.readFileSync(path.resolve(root, relFile), 'utf8');
    } catch {
      return;
    }

    const importerPath = path.resolve(root, relFile);
    extractImportSpecifiers(content).forEach(specifier => {
      resolveImportTargets(specifier, relFile, root, context).forEach(target => {
        if (!index.has(target)) index.set(target, new Set());
        index.get(target).add(importerPath);
      });
    });
  });

  cachedReverseImportIndex = { root, index };
  return index;
}

/**
 * Finds test files related to one source file. Combines:
 *   1. naming-convention matches, and
 *   2. a reverse-dependency walk through the import graph, limited to
 *      `maxDepth` edges from the source file.
 *
 * Depth 1 = test imports the source directly.
 * Depth 2 = test imports a module that imports the source (e.g. a barrel).
 *
 * @param {string} sourceFile - Path to source file (relative to root)
 * @param {{root?: string, maxDepth?: number}} [options]
 * @returns {string[]} - Related test file paths relative to root, sorted
 */
export function findRelatedTestFilesBySource(sourceFile, {
  root = process.cwd(),
  maxDepth = 2
} = {}) {
  const related = new Set(findTestFilesForSourceInRoot(sourceFile, root));
  const depthLimit = Math.max(0, Number.parseInt(maxDepth, 10) || 0);
  if (depthLimit === 0) {
    return Array.from(related).sort();
  }

  const reverseIndex = buildReverseImportIndex(root);
  const start = path.resolve(root, sourceFile);
  const visited = new Set([start]);
  let frontier = new Set([start]);

  for (let depth = 1; depth <= depthLimit && frontier.size > 0; depth++) {
    const next = new Set();

    frontier.forEach(node => {
      const importers = reverseIndex.get(node);
      if (!importers) return;

      importers.forEach(importer => {
        if (visited.has(importer)) return;
        visited.add(importer);

        const relImporter = path.relative(root, importer);
        if (isTestFile(relImporter)) {
          related.add(relImporter);
        } else {
          // Non-test importers are only useful as traversal hops.
          next.add(importer);
        }
      });
    });

    frontier = next;
  }

  return Array.from(related).sort();
}

/**
 * Finds test files related to any of the given source files.
 * @param {string[]} sourceFiles - Source paths relative to root
 * @param {{root?: string, maxDepth?: number}} [options]
 * @returns {string[]} - Sorted, de-duplicated related test paths
 */
export function findRelatedTestFiles(sourceFiles, options = {}) {
  const related = new Set();
  sourceFiles.forEach(sourceFile => {
    findRelatedTestFilesBySource(sourceFile, options).forEach(testFile => related.add(testFile));
  });
  return Array.from(related).sort();
}
