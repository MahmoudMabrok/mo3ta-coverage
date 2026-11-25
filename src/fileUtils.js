import fs from 'fs';
import path from 'path';

const TEST_FILE_RE = /(\.test|\.spec)\.(js|ts|jsx|tsx)$/;
const JS_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo']);

// Matches import/require specifiers in JS/TS files:
//   import x from './mod'; import './mod'; export { x } from './mod';
//   require('./mod'); await import('./mod'); jest.mock('./mod');
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+|\bjest\.mock\s*\(\s*)['"]([^'"\n]+)['"]/g;

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
 * Drops cached directory walks. The CLI keeps the cache for one process;
 * long-running callers (the MCP server) clear it between tool calls.
 */
export function clearScanCaches() {
  cachedAllTestFiles = null;
  cachedAllJsFiles = null;
  cachedReverseImportIndex = null;
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

/**
 * Resolves a relative specifier ('./mod', '../src/mod') to existing file paths.
 * Tries the exact path, each JS extension, and directory index files.
 */
function resolveSpecifierCandidates(specifier, fromDir) {
  const base = path.resolve(fromDir, specifier);
  const candidates = [];

  const ext = path.extname(base);
  if (ext) {
    candidates.push(base);
    // TypeScript convention: an explicit './mod.js' import may resolve to './mod.ts'
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs') {
      ['.ts', '.tsx'].forEach(tsExt => candidates.push(base.slice(0, -ext.length) + tsExt));
    }
  } else {
    JS_EXTENSIONS.forEach(e => candidates.push(base + e));
    JS_EXTENSIONS.forEach(e => candidates.push(path.join(base, `index${e}`)));
  }

  return candidates.filter(candidate => fs.existsSync(candidate));
}

/**
 * Finds test files that import the given source file, regardless of
 * the test file's naming convention. Two matching strategies:
 *   1. Relative imports are resolved against the test file's directory
 *      and compared to the absolute source path.
 *   2. Non-relative specifiers (aliases like '@/utils/helper') are matched
 *      as a path suffix against the source path (extension stripped).
 * @param {string} sourceFile - Path to source file (relative to root)
 * @param {string} [root] - Directory to scan for test files (defaults to cwd)
 * @returns {string[]} - Array of test file paths (relative to root) that import the source file
 */
export function findTestFilesByImport(sourceFile, root = process.cwd()) {
  const resolvedSource = path.resolve(root, sourceFile);
  const sourceNoExt = sourceFile.replace(/\.(js|ts|jsx|tsx)$/, '').replace(/^\.\//, '');
  const matching = [];

  for (const testFile of findAllTestFiles(root)) {
    let content;
    try {
      content = fs.readFileSync(path.resolve(root, testFile), 'utf8');
    } catch {
      continue;
    }

    const specifiers = extractImportSpecifiers(content);
    let matched = false;

    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        // Relative import: resolve and compare absolute paths
        const fromDir = path.dirname(path.resolve(root, testFile));
        const candidates = resolveSpecifierCandidates(specifier, fromDir);
        if (candidates.includes(resolvedSource)) {
          matched = true;
          break;
        }
      } else {
        // Alias or package-style import: compare path suffix (no extension).
        // '@/' is the most common alias (maps to 'src/'), so strip it before comparing.
        let specifierNoExt = specifier.replace(/\.(js|ts|jsx|tsx)$/, '');
        if (specifierNoExt.startsWith('@/')) {
          specifierNoExt = specifierNoExt.slice(2);
        }
        if (
          specifierNoExt &&
          (sourceNoExt === specifierNoExt || sourceNoExt.endsWith(`/${specifierNoExt}`))
        ) {
          matched = true;
          break;
        }
      }
    }

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
  return filePath.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '');
}

/**
 * Builds a lookup of repo-relative paths without extensions. Multiple files can
 * share a path stem when they use different extensions (e.g. helper.js/.ts).
 */
function buildNoExtIndex(files) {
  const index = new Map();
  files.forEach(file => {
    const key = stripJsExtension(file);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(file);
  });
  return index;
}

/**
 * Resolves a non-relative (alias or package-style) specifier to files under
 * root. Heuristics, in order:
 *   1. exact repo-relative stem match ('src/utils/helper'),
 *   2. path-suffix match ('utils/helper' → 'src/utils/helper').
 * '@/x' and '~/x' aliases are normalized before matching.
 */
function resolveNonRelativeSpecifier(specifier, root, noExtIndex) {
  let stem = stripJsExtension(specifier);
  if (stem.startsWith('@/') || stem.startsWith('~/')) {
    stem = stem.slice(2);
  }
  if (!stem) return [];

  const exact = noExtIndex.get(stem);
  if (exact) {
    return exact.map(file => path.resolve(root, file));
  }

  const suffix = `/${stem}`;
  const matches = [];
  for (const [key, files] of noExtIndex) {
    if (key.endsWith(suffix)) {
      files.forEach(file => matches.push(path.resolve(root, file)));
    }
  }
  return matches;
}

/**
 * Resolves an import specifier found in `fromFile` to absolute file paths.
 * Relative specifiers resolve against the importing file's directory; alias
 * and package-style specifiers resolve against the repo-relative file index.
 */
function resolveImportTargets(specifier, fromFile, root, noExtIndex) {
  if (specifier.startsWith('.')) {
    const fromDir = path.dirname(path.resolve(root, fromFile));
    return resolveSpecifierCandidates(specifier, fromDir);
  }
  return resolveNonRelativeSpecifier(specifier, root, noExtIndex);
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
  const noExtIndex = buildNoExtIndex(files);
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
      resolveImportTargets(specifier, relFile, root, noExtIndex).forEach(target => {
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
