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
