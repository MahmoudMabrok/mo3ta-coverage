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
 * Finds potential test files for a given source file
 * Checks multiple naming conventions and locations
 * @param {string} sourceFile - Path to source file
 * @returns {string[]} - Array of potential test file paths
 */
export function findTestFilesForSource(sourceFile) {
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

  // Check which test files actually exist
  return testFiles.filter(testFile => fs.existsSync(testFile));
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
