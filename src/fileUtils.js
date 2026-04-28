import fs from 'fs';
import path from 'path';

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

/**
 * Extracts import paths from a file (ESM and CommonJS)
 * @param {string} filePath - Path to source file
 * @returns {string[]} - Array of imported file paths
 */
export function extractImports(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const imports = new Set();
    
    // ESM imports: import x from 'path'
    const esmRegex = /import\s+(?:.*?)\s+from\s+['"`]([^'"`]+)['"`]/g;
    let match;
    while ((match = esmRegex.exec(content)) !== null) {
      imports.add(match[1]);
    }

    // ESM side-effect imports: import 'path'
    const sideEffectImportRegex = /import\s+['"`]([^'"`]+)['"`]/g;
    while ((match = sideEffectImportRegex.exec(content)) !== null) {
      imports.add(match[1]);
    }
    
    // CommonJS requires: require('path')
    const cjsRegex = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    while ((match = cjsRegex.exec(content)) !== null) {
      imports.add(match[1]);
    }
    
    return Array.from(imports);
  } catch (error) {
    return [];
  }
}

/**
 * Resolves relative imports to absolute file paths
 * @param {string} importPath - Import path (relative or module name)
 * @param {string} fromFile - File doing the importing
 * @returns {string|null} - Resolved file path or null if not found
 */
export function resolveImportPath(importPath, fromFile) {
  // Skip node_modules and external packages
  if (importPath.startsWith('.') === false) {
    return null;
  }
  
  const fromDir = path.dirname(fromFile);
  let resolvedPath = path.resolve(fromDir, importPath);
  
  // Try with file extensions if no extension provided
  const extensions = ['.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];
  for (const ext of extensions) {
    const candidate = resolvedPath + ext;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  
  // Also try without adding extension
  if (fs.existsSync(resolvedPath)) {
    return resolvedPath;
  }
  
  return null;
}

/**
 * Finds all files that import the given files (reverse dependencies)
 * up to a specified depth
 * @param {string[]} changedFiles - Changed files to find reverse deps for
 * @param {number} maxDepth - Maximum depth to traverse (default 3)
 * @returns {string[]} - Array of files that import changed files
 */
export function findReverseDeps(changedFiles, maxDepth = 3) {
  const reverseDeps = new Set();
  const visited = new Set();
  
  // Get all source files to check
  let allSourceFiles = [];
  try {
    const srcDir = 'src';
    if (fs.existsSync(srcDir)) {
      const walk = (dir) => {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          
          if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
            walk(fullPath);
          } else if (file.match(/\.(js|ts|jsx|tsx)$/) && !file.match(/(\.test|\.spec)\./)) {
            allSourceFiles.push(fullPath);
          }
        });
      };
      walk(srcDir);
    }
  } catch (error) {
    return [];
  }
  
  // BFS to find reverse deps up to maxDepth
  let currentLevel = new Set(changedFiles.map(f => path.resolve(f)));
  let depth = 0;
  
  while (depth < maxDepth && currentLevel.size > 0) {
    const nextLevel = new Set();
    
    allSourceFiles.forEach(sourceFile => {
      const absoluteSourceFile = path.resolve(sourceFile);

      if (visited.has(absoluteSourceFile)) return;
      
      const imports = extractImports(sourceFile);
      let importsCurrentLevel = false;
      
      imports.forEach(imp => {
        const resolved = resolveImportPath(imp, sourceFile);
        if (resolved && currentLevel.has(path.resolve(resolved))) {
          importsCurrentLevel = true;
        }
      });
      
      if (importsCurrentLevel) {
        nextLevel.add(absoluteSourceFile);
        reverseDeps.add(absoluteSourceFile);
      }
    });
    
    currentLevel.forEach(f => visited.add(f));
    currentLevel = nextLevel;
    depth++;
  }
  
  return Array.from(reverseDeps);
}
