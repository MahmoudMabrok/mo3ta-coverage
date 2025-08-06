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
