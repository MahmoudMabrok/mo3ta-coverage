import {
  separateSourceAndTestFiles,
  findRelatedTestFilesBySource,
  findTestFilesForSource,
  findTestFilesByImport
} from '../fileUtils.js';

function normalizeFilterRegex(filterRegex, filter) {
  const raw = filterRegex ?? filter ?? null;
  if (!raw) return null;
  if (raw instanceof RegExp) {
    return new RegExp(raw.source, raw.flags.replace(/[gy]/g, ''));
  }
  const pattern = String(raw).trim();
  return pattern ? new RegExp(pattern) : null;
}

function applyFilter(files, filterRegex) {
  if (!filterRegex) return [...files];
  return files.filter(file => filterRegex.test(file));
}

/**
 * Resolves a test execution plan using the native naming-convention and
 * filesystem import-graph engine (`fast` and `smart` modes).
 *
 * @param {{
 *   files: string[],
 *   mode: string,
 *   depth?: number,
 *   root?: string,
 *   extraJestArgs?: string[],
 *   filterRegex?: RegExp | null,
 *   filter?: string | RegExp | null
 * }} params
 */
export function resolveNativePlan({
  files = [],
  mode,
  depth = 2,
  root = process.cwd(),
  extraJestArgs = [],
  filterRegex = null,
  filter = null
}) {
  const { sourceFiles, testFiles } = separateSourceAndTestFiles(files);
  const activeFilter = normalizeFilterRegex(filterRegex, filter);
  const extra = Array.isArray(extraJestArgs) ? extraJestArgs : [];

  const allTestFilesToRun = new Set(testFiles);
  const mappings = [];

  sourceFiles.forEach(sourceFile => {
    let relatedTests;
    let matchType;

    if (mode === 'smart') {
      relatedTests = findRelatedTestFilesBySource(sourceFile, { maxDepth: depth, root });
      matchType = `naming + import graph, depth ≤ ${depth}`;
    } else {
      relatedTests = findTestFilesForSource(sourceFile, root);
      matchType = 'naming convention';

      if (relatedTests.length === 0) {
        relatedTests = findTestFilesByImport(sourceFile, root);
        if (relatedTests.length > 0) {
          matchType = 'import scan';
        }
      }
    }

    const filteredTests = applyFilter(relatedTests, activeFilter);
    mappings.push({
      source: sourceFile,
      tests: filteredTests,
      allTests: [...relatedTests],
      matchType
    });
    relatedTests.forEach(test => allTestFilesToRun.add(test));
  });

  const allTestsToRun = Array.from(allTestFilesToRun);
  const testsToRun = applyFilter(allTestsToRun, activeFilter);

  return {
    mode,
    depth,
    filter: activeFilter ? activeFilter.source : null,
    sourceFiles,
    testFiles,
    mappings,
    allTestsToRun,
    testsToRun,
    jestTargets: testsToRun,
    jestArgs: ['--passWithNoTests', '--coverage', ...testsToRun, ...extra],
    delegatedToJest: false,
    engine: mode === 'smart' ? 'native' : null,
    requestedEngine: mode === 'smart' ? 'native' : null,
    fallbackUsed: false,
    warnings: [],
    metrics: null,
    projects: null,
    projectMatches: null,
    explanation: null,
    jestVersion: null
  };
}
