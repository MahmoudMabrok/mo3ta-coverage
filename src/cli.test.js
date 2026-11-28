import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import jestLoader from './engines/jestLoader.cjs';
import {
  buildMarkdownCoverageReport,
  classifyChangedLineCoverage,
  dryRun,
  filterTestFiles,
  formatMissedLinesSummary,
  getChangedFiles,
  getExplicitFiles,
  listChangedSourceFiles,
  normalizeExplicitFiles,
  parseFilter,
  parseJestArgs,
  parseLcov,
  readExplicitFilesFromFile,
  resolveJestBin,
  resolveTestPlan,
  summarizeCoverageResult,
  writeMarkdownReport
} from './cli.js';

const { PACKAGE_ROOT } = jestLoader;

function linkFixtureNodeModules(root) {
  const targetModules = path.join(PACKAGE_ROOT, 'node_modules');
  const fixtureModules = path.join(root, 'node_modules');
  fs.mkdirSync(fixtureModules, { recursive: true });
  for (const entry of fs.readdirSync(targetModules)) {
    const src = path.join(targetModules, entry);
    const dest = path.join(fixtureModules, entry);
    if (entry === 'jest') {
      // Copy the small `jest` wrapper package so realpath(jest/package.json) stays inside `root`.
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.symlinkSync(src, dest, 'dir');
    }
  }
}

function writeLcovFixture(records) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-coverage-'));
  const sourceFile = path.join(tempDir, 'src/example.js');
  const lcovFile = path.join(tempDir, 'lcov.info');

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'const x = 1;\nconst y = 2;\n');
  fs.writeFileSync(
    lcovFile,
    [
      'TN:',
      `SF:${sourceFile}`,
      ...records,
      'end_of_record'
    ].join('\n')
  );

  return { sourceFile, lcovFile };
}

describe('parseLcov', () => {
  it('records both coverableLines and uncoveredLines', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,1', 'DA:11,0']);

    const result = parseLcov(lcovFile);

    expect(result[sourceFile].coverableLines.has(10)).toBe(true);
    expect(result[sourceFile].coverableLines.has(11)).toBe(true);
    expect(result[sourceFile].uncoveredLines.has(10)).toBe(false);
    expect(result[sourceFile].uncoveredLines.has(11)).toBe(true);
  });
});

describe('classifyChangedLineCoverage', () => {
  it('filters out changed lines not in LCOV (like imports)', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,1']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([11, 12, 13, 14], coverage);

    expect(result.coveredLines).toEqual([]);
    expect(result.uncoveredLines).toEqual([]);
  });

  it('ignores changed lines with no LCOV entry and classifies rest as covered or uncovered', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,3', 'DA:11,0']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([10, 11, 12, 13], coverage);

    expect(result.coveredLines).toEqual([10]);
    expect(result.uncoveredLines).toEqual([11]);
  });

  it('keeps existing behavior for normal covered and uncovered LCOV lines', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:20,5', 'DA:21,0']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([20, 21], coverage);

    expect(result.coveredLines).toEqual([20]);
    expect(result.uncoveredLines).toEqual([21]);
  });
});

describe('summarizeCoverageResult', () => {
  it('passes when overall coverage equals the configured limit', () => {
    const result = summarizeCoverageResult(5, 1, 80);

    expect(result.overallCoverage).toBe(80);
    expect(result.passed).toBe(true);
    expect(result.icon).toBe('✅');
  });

  it('fails when overall coverage is below the configured limit', () => {
    const result = summarizeCoverageResult(5, 2, 80);

    expect(result.overallCoverage).toBe(60);
    expect(result.passed).toBe(false);
    expect(result.icon).toBe('🚨');
  });
});

describe('formatMissedLinesSummary', () => {
  it('formats uncovered files and lines for the final summary', () => {
    const result = formatMissedLinesSummary([
      { filePath: 'src/a.js', lines: [10, 11] },
      { filePath: 'src/b.js', lines: [7] }
    ]);

    expect(result).toEqual([
      '',
      'Missed changed lines by file:',
      ` - ${path.resolve('src/a.js')}:10`,
      ` - ${path.resolve('src/a.js')}:11`,
      ` - ${path.resolve('src/b.js')}:7`
    ]);
  });

  it('returns no summary lines when no files have missed lines', () => {
    expect(formatMissedLinesSummary([])).toEqual([]);
  });
});

describe('buildMarkdownCoverageReport', () => {
  it('renders a markdown table with per-file rows and an overall line', () => {
    const report = buildMarkdownCoverageReport(
      [
        { filePath: 'src/a.js', covered: 4, uncovered: 1, trackedChangedLines: 5, fileCoverage: '80.00%', status: '🚨' },
        { filePath: 'src/b.js', covered: 3, uncovered: 0, trackedChangedLines: 3, fileCoverage: '100.00%', status: '✅' }
      ],
      { overallCoverage: '87.50', changedLinesLimit: 80, totalChanged: 8, totalNotCovered: 1 }
    );

    expect(report).toContain('| Status | File | Changed coverable lines | Covered | Uncovered | Coverage |');
    expect(report).toContain('| --- | --- | ---: | ---: | ---: | ---: |');
    expect(report).toContain('| 🚨 | `src/a.js` | 5 | 4 | 1 | 80.00% |');
    expect(report).toContain('| ✅ | `src/b.js` | 3 | 3 | 0 | 100.00% |');
    expect(report).toContain('| **Overall** | — | 8 | 7 | 1 | 87.50% |');
    expect(report).toContain('Overall coverage: **87.50%** (limit: 80%) — 7/8 changed lines covered, 1 uncovered.');
  });

  it('notes when there are no coverable changed lines', () => {
    const report = buildMarkdownCoverageReport([], {
      overallCoverage: null,
      changedLinesLimit: 80,
      totalChanged: 0,
      totalNotCovered: 0
    });

    expect(report).toContain('**No coverable changed lines found.**');
  });
});

describe('writeMarkdownReport', () => {
  it('creates parent directories and writes the report file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-report-'));
    const reportPath = path.join(tempDir, 'nested', 'report.md');

    writeMarkdownReport('# report\n', reportPath);

    expect(fs.readFileSync(reportPath, 'utf8')).toBe('# report\n\n');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('normalizeExplicitFiles', () => {
  it('accepts a comma-separated string', () => {
    expect(normalizeExplicitFiles('src/a.js,src/b.ts')).toEqual([
      'src/a.js',
      'src/b.ts'
    ]);
  });

  it('accepts an array of paths', () => {
    expect(normalizeExplicitFiles(['src/a.js', 'src/b.ts'])).toEqual([
      'src/a.js',
      'src/b.ts'
    ]);
  });

  it('trims, drops empty entries, and removes duplicates', () => {
    expect(normalizeExplicitFiles(['  src/a.js  ', '', 'src/a.js', 'src/b.js'])).toEqual([
      'src/a.js',
      'src/b.js'
    ]);
  });

  it('converts absolute paths under the root to relative paths', () => {
    const root = path.resolve('/tmp/project');

    expect(normalizeExplicitFiles([path.join(root, 'src/a.js')], root)).toEqual([
      'src/a.js'
    ]);
  });

  it('drops dependency and build artifacts', () => {
    expect(normalizeExplicitFiles([
      'src/a.js',
      'node_modules/pkg/index.js',
      'coverage/lcov-report/x.js',
      'dist/bundle.js',
      'build/out.js'
    ])).toEqual(['src/a.js']);
  });
});

describe('readExplicitFilesFromFile', () => {
  it('reads a newline-separated list from disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-files-'));
    const listPath = path.join(tempDir, 'files.txt');
    fs.writeFileSync(listPath, 'src/a.js\nsrc/b.ts\n\n');

    expect(readExplicitFilesFromFile(listPath, tempDir)).toEqual([
      'src/a.js',
      'src/b.ts'
    ]);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('getExplicitFiles', () => {
  it('returns an empty list when no explicit options are provided', () => {
    expect(getExplicitFiles({})).toEqual([]);
  });

  it('combines --files and --filesFrom, removing duplicates', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-files-'));
    const listPath = path.join(tempDir, 'files.txt');
    fs.writeFileSync(listPath, 'src/b.js\nsrc/a.js\n');

    expect(getExplicitFiles({
      files: ['src/a.js'],
      filesFrom: listPath
    })).toEqual(['src/a.js', 'src/b.js']);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('parseJestArgs', () => {
  it('returns an empty array for no input', () => {
    expect(parseJestArgs()).toEqual([]);
    expect(parseJestArgs(null)).toEqual([]);
    expect(parseJestArgs(undefined)).toEqual([]);
  });

  it('accepts a single flag string', () => {
    expect(parseJestArgs('--silent')).toEqual(['--silent']);
  });

  it('splits a comma-separated string into flags', () => {
    expect(parseJestArgs('--maxWorkers=2,--silent')).toEqual(['--maxWorkers=2', '--silent']);
  });

  it('accepts an array of flags (repeatable --jest)', () => {
    expect(parseJestArgs(['--maxWorkers=2', '--silent'])).toEqual(['--maxWorkers=2', '--silent']);
  });

  it('trims, drops empty entries, and de-duplicates preserving order', () => {
    expect(parseJestArgs([' --silent', ' --silent', '', '  ', '--ci'])).toEqual(['--silent', '--ci']);
  });
});

describe('parseFilter', () => {
  it('returns null for no input', () => {
    expect(parseFilter()).toBeNull();
    expect(parseFilter(null)).toBeNull();
    expect(parseFilter('')).toBeNull();
    expect(parseFilter('   ')).toBeNull();
  });

  it('compiles a string pattern into a RegExp', () => {
    const filter = parseFilter('src/__tests__/login');
    expect(filter).toBeInstanceOf(RegExp);
    expect(filter.test('src/__tests__/login.spec.js')).toBe(true);
    expect(filter.test('src/auth/logout.spec.js')).toBe(false);
  });

  it('trims surrounding whitespace from the pattern', () => {
    expect(parseFilter('  login  ').source).toBe('login');
  });

  it('accepts a RegExp input and drops global/sticky flags', () => {
    const filter = parseFilter(/login/g);
    expect(filter.source).toBe('login');
    expect(filter.flags).toBe('');
    // Repeating .test() must not depend on lastIndex.
    expect(filter.test('a/login.spec.js')).toBe(true);
    expect(filter.test('a/login.spec.js')).toBe(true);
  });

  it('throws an INVALID_FILTER error for a malformed pattern', () => {
    expect(() => parseFilter('(unclosed')).toThrow(/Invalid filter regex/);
    try {
      parseFilter('(unclosed');
    } catch (error) {
      expect(error.code).toBe('INVALID_FILTER');
    }
  });
});

describe('filterTestFiles', () => {
  it('returns a copy of the input when no filter is given', () => {
    const files = ['src/a.test.js', 'src/b.test.js'];
    const result = filterTestFiles(files);
    expect(result).toEqual(files);
    expect(result).not.toBe(files);
  });

  it('keeps only the paths that match the regex', () => {
    const files = ['src/__tests__/login.spec.js', 'src/auth/logout.spec.js', 'src/login.tsx.test.ts'];
    const result = filterTestFiles(files, 'login');
    expect(result).toEqual(['src/__tests__/login.spec.js', 'src/login.tsx.test.ts']);
  });

  it('supports a RegExp instance as the filter', () => {
    const files = ['src/foo.test.js', 'src/bar.test.js'];
    const result = filterTestFiles(files, /foo/);
    expect(result).toEqual(['src/foo.test.js']);
  });
});

describe('resolveTestPlan spec filter', () => {
  let tempDir;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-filter-plan-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'example.js'), 'export const example = 1;\n');
    fs.writeFileSync(
      path.join(tempDir, 'src', 'example.test.js'),
      "import { example } from './example';\n\ntest('naming match', () => expect(example).toBe(1));\n"
    );
    fs.mkdirSync(path.join(tempDir, 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'specs', 'custom-name.spec.js'),
      "import { example } from '../src/example';\n\ntest('import match', () => expect(example).toBe(1));\n"
    );
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('filters selected tests and keeps the pre-filter list for validation', () => {
    const plan = resolveTestPlan(['src/example.js'], 'smart', 2, tempDir, [], 'specs\\/');

    expect(plan.filter).toBe('specs\\/');
    expect(plan.allTestsToRun).toEqual(['specs/custom-name.spec.js', 'src/example.test.js']);
    expect(plan.testsToRun).toEqual(['specs/custom-name.spec.js']);
    expect(plan.jestTargets).toEqual(['specs/custom-name.spec.js']);
    expect(plan.jestArgs).toEqual(['--passWithNoTests', '--coverage', 'specs/custom-name.spec.js']);
  });

  it('removes test files when the filter matches none', () => {
    const plan = resolveTestPlan(['src/example.js'], 'smart', 2, tempDir, [], 'not-a-match');

    expect(plan.allTestsToRun).toEqual(['specs/custom-name.spec.js', 'src/example.test.js']);
    expect(plan.testsToRun).toEqual([]);
    expect(plan.jestArgs).toEqual(['--passWithNoTests', '--coverage']);
  });

  it('keeps the per-source "allTests" for the validation log when the filter drops everything', () => {
    const plan = resolveTestPlan(['src/example.js'], 'smart', 2, tempDir, [], 'not-a-match');

    plan.mappings.forEach(mapping => {
      expect(mapping.tests).toEqual([]);
      expect(mapping.allTests).toEqual(['specs/custom-name.spec.js', 'src/example.test.js']);
    });
  });

  it('leaves the plan untouched when no filter is given', () => {
    const plan = resolveTestPlan(['src/example.js'], 'smart', 2, tempDir);

    expect(plan.filter).toBeNull();
    expect(plan.allTestsToRun).toEqual(['specs/custom-name.spec.js', 'src/example.test.js']);
    expect(plan.testsToRun).toEqual(['specs/custom-name.spec.js', 'src/example.test.js']);
  });

  it('forwards the filter to Jest via --testPathPatterns in full mode', () => {
    const plan = resolveTestPlan(
      ['src/example.js', 'src/example.test.js'],
      'full',
      2,
      tempDir,
      [],
      'example'
    );

    expect(plan.delegatedToJest).toBe(true);
    expect(plan.allTestsToRun).toEqual(['src/example.test.js']);
    expect(plan.testsToRun).toEqual(['src/example.test.js']);
    expect(plan.jestTargets).toEqual(['src/example.js', 'src/example.test.js']);
    expect(plan.jestArgs).toContain('--findRelatedTests');
    expect(plan.jestArgs).toContain('--testPathPatterns');
    expect(plan.jestArgs).toContain('example');
  });

  it('does not duplicate a Jest path pattern the caller already set in full mode', () => {
    const plan = resolveTestPlan(
      ['src/example.js'],
      'full',
      2,
      tempDir,
      ['--testPathPatterns=login'],
      'example'
    );

    expect(plan.jestArgs).toContain('--testPathPatterns=login');
    expect(plan.jestArgs).not.toContain('--testPathPatterns');
    expect(plan.jestArgs.filter(arg => arg.startsWith('--testPathPatterns'))).toEqual(
      ['--testPathPatterns=login']
    );
  });
});

describe('resolveTestPlan jest flags', () => {
  it('appends extra flags to fast mode jestArgs after the test files', () => {
    const plan = resolveTestPlan(['src/example.test.js'], 'fast', 2, process.cwd(), ['--maxWorkers=2', '--silent']);

    expect(plan.jestArgs).toEqual(['--passWithNoTests', '--coverage', 'src/example.test.js', '--maxWorkers=2', '--silent']);
  });

  it('appends extra flags to full mode jestArgs after the targets', () => {
    const plan = resolveTestPlan(['src/example.js', 'src/example.test.js'], 'full', 2, process.cwd(), ['--silent']);

    expect(plan.jestArgs).toEqual(['--findRelatedTests', '--passWithNoTests', '--coverage', 'src/example.js', 'src/example.test.js', '--silent']);
  });

  it('omits extra flags when none are provided', () => {
    const plan = resolveTestPlan(['src/example.test.js'], 'fast', 2, process.cwd());

    expect(plan.jestArgs).toEqual(['--passWithNoTests', '--coverage', 'src/example.test.js']);
  });
});

describe('getChangedFiles', () => {
  let tempDir;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-git-'));

    execSync('git init -b main -q', { cwd: tempDir });
    execSync('git config user.name "Base Author"', { cwd: tempDir });
    execSync('git config user.email "base@example.com"', { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'base.js'), 'export const base = 1;\n');
    execSync('git add base.js && git commit -q -m "base"', { cwd: tempDir });
    execSync('git checkout -q -b feature', { cwd: tempDir });

    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('includes changed files regardless of the commit author', () => {
    fs.writeFileSync(path.join(tempDir, 'by-other.js'), 'export const other = 1;\n');
    execSync('git add by-other.js && git -c user.name="Other Dev" -c user.email="other@example.com" commit -q -m "other author"', { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'by-me.js'), 'export const me = 1;\n');
    execSync('git add by-me.js && git commit -q -m "current author"', { cwd: tempDir });

    const result = getChangedFiles('main');

    expect(result).toEqual(['by-me.js', 'by-other.js']);
  });

  it('includes uncommitted and staged changes', () => {
    fs.writeFileSync(path.join(tempDir, 'base.js'), 'export const base = 2;\n');
    fs.writeFileSync(path.join(tempDir, 'staged.js'), 'export const b = 1;\n');
    execSync('git add staged.js', { cwd: tempDir });

    const result = getChangedFiles('main');

    expect(result).toEqual(['base.js', 'staged.js']);
  });
});

describe('dryRun', () => {
  let tempDir;
  let originalCwd;
  let originalLog;
  let originalError;
  let exitSpy;
  let stdoutLines;
  let stderrLines;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-dry-run-'));

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'example.js'), 'export const example = 1;\n');
    fs.writeFileSync(
      path.join(tempDir, 'src', 'example.test.js'),
      "import { example } from './example';\n\ntest('naming match', () => expect(example).toBe(1));\n"
    );
    fs.mkdirSync(path.join(tempDir, 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'specs', 'custom-name.spec.js'),
      "import { example } from '../src/example';\n\ntest('import match', () => expect(example).toBe(1));\n"
    );

    // A source file with no naming-convention match: only reachable by import.
    fs.writeFileSync(path.join(tempDir, 'src', 'bare.js'), 'export const bare = 1;\n');
    fs.writeFileSync(
      path.join(tempDir, 'specs', 'custom-name-bare.spec.js'),
      "import { bare } from '../src/bare';\n\ntest('bare import match', () => expect(bare).toBe(1));\n"
    );

    process.chdir(tempDir);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`exit:${code}`);
    });

    stdoutLines = [];
    stderrLines = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args) => stdoutLines.push(args.join(' '));
    console.error = (...args) => stderrLines.push(args.join(' '));
  });

  function runDryRun(files, mode = 'smart', depth = 2) {
    expect(() => dryRun(files, mode, depth)).toThrow(/^exit:/);
  }

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    exitSpy.mockRestore();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints one matched test path per line (naming + depth-1 import match)', () => {
    runDryRun(['src/example.js'], 'smart');

    expect(stdoutLines).toEqual(['specs/custom-name.spec.js', 'src/example.test.js']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('honors the depth limit (depth 0 = naming matches only)', () => {
    runDryRun(['src/example.js'], 'smart', 0);

    expect(stdoutLines).toEqual(['src/example.test.js']);
  });

  it('uses the import-scan fallback in fast mode when no naming match exists', () => {
    runDryRun(['src/bare.js'], 'fast');

    expect(stdoutLines).toEqual(['specs/custom-name-bare.spec.js']);
  });

  it('prints the changed test files themselves', () => {
    runDryRun(['src/example.test.js']);

    expect(stdoutLines).toEqual(['src/example.test.js']);
  });

  it('prints no paths and exits when there are no changed files', () => {
    runDryRun([]);

    expect(stdoutLines).toEqual([]);
    expect(stderrLines.some(line => line.includes('No changed source files'))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('full mode warns on stderr and prints only the changed test files', () => {
    runDryRun(['src/example.js', 'src/example.test.js'], 'full');

    expect(stdoutLines).toEqual(['src/example.test.js']);
    expect(stderrLines.some(line => line.includes('--findRelatedTests'))).toBe(true);
  });

  it('prints the before/after filter log on stderr and only filtered paths on stdout', () => {
    expect(() => dryRun(['src/example.js'], 'smart', 2, 'example\\.test\\.js$')).toThrow(/^exit:/);

    // The changed file's naming-match test survives the filter; the import-scan
    // spec does not.
    expect(stdoutLines).toEqual(['src/example.test.js']);
    expect(stderrLines.some(line => line.includes('Filter regex'))).toBe(true);
    expect(stderrLines.some(line => line.includes('specs/custom-name.spec.js'))).toBe(true);
    expect(stderrLines.some(line => line.includes('src/example.test.js'))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints nothing on stdout when the filter matches no test file', () => {
    expect(() => dryRun(['src/example.js'], 'smart', 2, 'zzz-no-match')).toThrow(/^exit:/);

    expect(stdoutLines).toEqual([]);
    expect(stderrLines.some(line => line.includes('after filter (0)'))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('jest engine CLI integration', () => {
  let tempDir;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-cli-jest-'));
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'leaf.js'), 'exports.leaf = () => 42;\n');
    fs.writeFileSync(path.join(tempDir, 'src', 'mid.js'), "const { leaf } = require('./leaf');\nexports.mid = () => leaf();\n");
    fs.writeFileSync(
      path.join(tempDir, 'specs', 'mid.spec.js'),
      "const { mid } = require('../src/mid');\ntest('mid', () => expect(mid()).toBe(42));\n"
    );
    fs.writeFileSync(
      path.join(tempDir, 'jest.config.js'),
      "module.exports = { testMatch: ['**/specs/**/*.spec.js'] };\n"
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolveJestBin delegates to jestLoader and preserves missing-jest fallback path', () => {
    expect(resolveJestBin(tempDir)).toBe(path.resolve(tempDir, 'node_modules', 'jest', 'bin', 'jest.js'));
  });

  it('listChangedSourceFiles includes .snap files only when includeSnapshots is true', () => {
    execSync('git init -b main -q', { cwd: tempDir });
    execSync('git config user.name "Test"', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git add -A && git commit -q -m init', { cwd: tempDir });

    fs.mkdirSync(path.join(tempDir, 'specs', '__snapshots__'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'specs', '__snapshots__', 'mid.spec.js.snap'), '// snap\n');
    execSync('git add specs/__snapshots__/mid.spec.js.snap', { cwd: tempDir });

    expect(listChangedSourceFiles('main', tempDir)).toEqual([]);
    expect(listChangedSourceFiles('main', tempDir, { includeSnapshots: true })).toEqual([
      'specs/__snapshots__/mid.spec.js.snap'
    ]);
  });

  it('resolveTestPlan uses Jest 30 engine when Jest is installed in the fixture', () => {
    linkFixtureNodeModules(tempDir);

    const plan = resolveTestPlan(['src/leaf.js'], 'smart', 2, tempDir, [], null, {
      engine: 'jest',
      explain: true
    });

    expect(plan.engine).toBe('jest');
    expect(plan.requestedEngine).toBe('jest');
    expect(plan.fallbackUsed).toBe(false);
    expect(plan.testsToRun).toEqual(['specs/mid.spec.js']);
    expect(plan.jestArgs).toContain('--runTestsByPath');
    expect(plan.jestVersion).toMatch(/^30\./);
    expect(plan.explanation).toEqual([
      expect.objectContaining({
        source: 'src/leaf.js',
        test: 'specs/mid.spec.js',
        depth: 2,
        path: ['src/leaf.js', 'src/mid.js', 'specs/mid.spec.js']
      })
    ]);
  });

  it('resolveTestPlan throws JEST_NOT_FOUND when Jest is missing and fallback is error', () => {
    let caught = null;
    try {
      resolveTestPlan(['src/leaf.js'], 'smart', 2, tempDir, [], null, {
        engine: 'jest',
        fallback: 'error'
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe('JEST_NOT_FOUND');
  });

  it('resolveTestPlan falls back to native engine with a warning when fallback is native', () => {
    const plan = resolveTestPlan(['src/leaf.js'], 'smart', 2, tempDir, [], null, {
      engine: 'jest',
      fallback: 'native'
    });

    expect(plan.engine).toBe('native');
    expect(plan.requestedEngine).toBe('jest');
    expect(plan.fallbackUsed).toBe(true);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('falling back to native engine');
    expect(plan.testsToRun).toEqual(['specs/mid.spec.js']);
  });

  it('dryRun with engine jest and explain prints clean paths to stdout and explanations to stderr', () => {
    linkFixtureNodeModules(tempDir);
    process.chdir(tempDir);

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`exit:${code}`);
    });
    const stdoutLines = [];
    const stderrLines = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => stdoutLines.push(args.join(' '));
    console.error = (...args) => stderrLines.push(args.join(' '));

    try {
      expect(() => dryRun(['src/leaf.js'], 'smart', 2, null, [], {
        engine: 'jest',
        explain: true
      })).toThrow('exit:0');

      expect(stdoutLines).toEqual(['specs/mid.spec.js']);
      expect(stderrLines.some(line => line.includes('Dependency explanations'))).toBe(true);
      expect(stderrLines.some(line => line.includes('src/leaf.js -> specs/mid.spec.js (depth 2, path: src/leaf.js -> src/mid.js -> specs/mid.spec.js)'))).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origError;
      exitSpy.mockRestore();
    }
  });
});
