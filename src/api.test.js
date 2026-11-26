import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import {
  buildCapturedJestArgs,
  checkChangedLineCoverage,
  listChangedFiles,
  mapRelatedTests,
  Mo3taError
} from './api.js';

function git(repo, command) {
  execSync(command, { cwd: repo, stdio: 'pipe' });
}

function initRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, 'git init -b main -q');
  git(root, 'git config user.email test@example.com');
  git(root, 'git config user.name Test');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'keep.js'), 'module.exports = { keep: 1 };\n');
  git(root, 'git add src/keep.js && git commit -q -m base');
  return root;
}

function writeMathFeature(root) {
  git(root, 'git checkout -q -b feature');
  fs.writeFileSync(path.join(root, 'src', 'math.js'), [
    'function add(a, b) {',
    '  return a + b;',
    '}',
    'function sub(a, b) {',
    '  return a - b;',
    '}',
    'module.exports = { add, sub };',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'math.test.js'), [
    "const { add } = require('./math');",
    "test('add', () => {",
    '  expect(add(1, 2)).toBe(3);',
    '});',
    ''
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'specs'));
  fs.writeFileSync(path.join(root, 'src', 'bare.js'), 'module.exports = { bare: 1 };\n');
  fs.writeFileSync(path.join(root, 'specs', 'custom-name.spec.js'), "const { bare } = require('../src/bare');\ntest('bare', () => expect(bare.bare).toBe(1));\n");
  git(root, 'git add src/math.js src/math.test.js src/bare.js specs/custom-name.spec.js && git commit -q -m feature');
}

describe('programmatic coverage API', () => {
  let root;

  afterEach(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    root = undefined;
  });

  it('adds --runInBand by default for captured runs', () => {
    expect(buildCapturedJestArgs(['--coverage'])).toEqual(['--coverage', '--watchAll=false', '--runInBand']);
  });

  it('drops --runInBand when the caller sets a worker strategy', () => {
    expect(buildCapturedJestArgs(['--maxWorkers=2'])).toEqual(['--maxWorkers=2', '--watchAll=false']);
    expect(buildCapturedJestArgs(['--maxWorkers', '2'])).toEqual(['--maxWorkers', '2', '--watchAll=false']);
    expect(buildCapturedJestArgs(['-w', '2'])).toEqual(['-w', '2', '--watchAll=false']);
    expect(buildCapturedJestArgs(['--runInBand'])).toEqual(['--runInBand', '--watchAll=false']);
    expect(buildCapturedJestArgs(['-i'])).toEqual(['-i', '--watchAll=false']);
  });

  it('rejects a directory that is not a git repo', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-not-git-'));
    expect(() => listChangedFiles({ root, useConfig: false })).toThrow(Mo3taError);
    try {
      listChangedFiles({ root, useConfig: false });
    } catch (error) {
      expect(error.code).toBe('NOT_A_GIT_REPO');
      expect(error.hint).toMatch(/checkout/);
    }
  });

  it('rejects a missing base ref with a fetch hint', () => {
    root = initRepo('mo3ta-bad-base-');
    expect(() => listChangedFiles({ root, base: 'origin/missing', useConfig: false })).toThrow(Mo3taError);
    try {
      listChangedFiles({ root, base: 'origin/missing', useConfig: false });
    } catch (error) {
      expect(error.code).toBe('INVALID_BASE_REF');
      expect(error.message).toContain('origin/missing');
      expect(error.hint).toMatch(/git fetch/);
    }
  });

  it('lists committed and unstaged JS/TS changes versus the base ref', () => {
    root = initRepo('mo3ta-list-');
    writeMathFeature(root);
    fs.writeFileSync(path.join(root, 'src', 'keep.js'), 'module.exports = { keep: 2 };\n');

    const result = listChangedFiles({ root, base: 'main', useConfig: false });

    expect(result.detection).toBe('git');
    expect(result.sourceFiles).toEqual(['src/bare.js', 'src/keep.js', 'src/math.js']);
    expect(result.testFiles).toEqual(['specs/custom-name.spec.js', 'src/math.test.js']);
    expect(result.summary).toContain('src/math.js');
  });

  it('scans an explicit list and does not fall back to git when nothing scannable remains', () => {
    root = initRepo('mo3ta-explicit-');
    writeMathFeature(root);

    const explicit = listChangedFiles({
      root,
      base: 'main',
      files: ['src/math.js'],
      useConfig: false
    });
    expect(explicit.detection).toBe('explicit');
    expect(explicit.sourceFiles).toEqual(['src/math.js']);

    const empty = listChangedFiles({
      root,
      base: 'main',
      files: ['node_modules/pkg/index.js'],
      useConfig: false
    });
    expect(empty.files).toEqual([]);
    expect(empty.warning).toMatch(/was not used/);
  });

  it('maps naming matches and the fast-mode import fallback', () => {
    root = initRepo('mo3ta-map-');
    writeMathFeature(root);

    const smart = mapRelatedTests({
      root,
      base: 'main',
      files: ['src/math.js', 'src/bare.js'],
      mode: 'fast',
      useConfig: false
    });

    const math = smart.mappings.find(mapping => mapping.source === 'src/math.js');
    const bare = smart.mappings.find(mapping => mapping.source === 'src/bare.js');
    expect(math.matchType).toBe('naming convention');
    expect(math.tests).toContain('src/math.test.js');
    expect(bare.matchType).toBe('import scan');
    expect(bare.tests).toEqual(['specs/custom-name.spec.js']);
    expect(smart.testsToRun).toEqual(expect.arrayContaining([
      'src/math.test.js',
      'specs/custom-name.spec.js'
    ]));
  });

  it('tells the caller that full mode cannot expand tests without Jest', () => {
    root = initRepo('mo3ta-full-');
    writeMathFeature(root);

    const result = mapRelatedTests({
      root,
      base: 'main',
      files: ['src/math.js'],
      mode: 'full',
      useConfig: false
    });

    expect(result.delegatedToJest).toBe(true);
    expect(result.testsToRun).toEqual([]);
    expect(result.jestTargets).toEqual(['src/math.js']);
    expect(result.warning).toMatch(/findRelatedTests/);
  });

  it('reads base and mode from .mo3ta-coverage.json unless arguments override them', () => {
    root = initRepo('mo3ta-config-');
    fs.writeFileSync(path.join(root, '.mo3ta-coverage.json'), JSON.stringify({
      base: 'main',
      mode: 'fast',
      depth: 1
    }));

    const fromFile = mapRelatedTests({ root, files: ['src/keep.js'] });
    expect(fromFile.base).toBe('main');
    expect(fromFile.mode).toBe('fast');

    const override = mapRelatedTests({ root, files: ['src/keep.js'], mode: 'full' });
    expect(override.mode).toBe('full');
  });

  it('accepts extra Jest flags and reads a jest default from the config file', () => {
    root = initRepo('mo3ta-jest-config-');
    writeMathFeature(root);
    const source = path.join(root, 'src', 'math.js');
    const lcov = path.join(root, 'coverage', 'lcov.info');
    fs.mkdirSync(path.dirname(lcov), { recursive: true });
    fs.writeFileSync(lcov, ['TN:', `SF:${source}`, 'DA:2,1', 'end_of_record', ''].join('\n'));

    const explicit = checkChangedLineCoverage({
      root,
      base: 'main',
      files: ['src/math.js'],
      mode: 'fast',
      runTests: false,
      jest: ['--maxWorkers=2', '--silent'],
      useConfig: false
    });
    expect(explicit.jestArgs).toEqual(['--maxWorkers=2', '--silent']);

    fs.writeFileSync(path.join(root, '.mo3ta-coverage.json'), JSON.stringify({
      base: 'main',
      mode: 'fast',
      jest: ['--bail']
    }));

    const fromConfig = checkChangedLineCoverage({
      root,
      files: ['src/math.js'],
      runTests: false
    });
    expect(fromConfig.jestArgs).toEqual(['--bail']);

    const override = checkChangedLineCoverage({
      root,
      files: ['src/math.js'],
      runTests: false,
      jest: '--maxWorkers=1,--silent'
    });
    expect(override.jestArgs).toEqual(['--maxWorkers=1', '--silent']);
  });

  it('reports an invalid config file instead of throwing a raw parse error', () => {
    root = initRepo('mo3ta-bad-config-');
    fs.writeFileSync(path.join(root, '.mo3ta-coverage.json'), '{');

    expect(() => listChangedFiles({ root })).toThrow(Mo3taError);
    try {
      listChangedFiles({ root });
    } catch (error) {
      expect(error.code).toBe('INVALID_CONFIG');
    }
  });

  it('grades an existing lcov file and returns the uncovered source line', () => {
    root = initRepo('mo3ta-lcov-');
    writeMathFeature(root);
    const source = path.join(root, 'src', 'math.js');
    const lcov = path.join(root, 'coverage', 'lcov.info');
    fs.mkdirSync(path.dirname(lcov), { recursive: true });
    fs.writeFileSync(lcov, [
      'TN:',
      `SF:${source}`,
      'DA:2,1',
      'DA:5,0',
      'end_of_record',
      ''
    ].join('\n'));

    const result = checkChangedLineCoverage({
      root,
      base: 'main',
      files: ['src/math.js'],
      mode: 'fast',
      limit: 80,
      runTests: false,
      showCovered: true,
      ciReport: 'coverage/mo3ta-coverage-report.md',
      useConfig: false
    });

    expect(result.coveragePassed).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.cliWouldExit).toBe(1);
    expect(result.totals).toEqual({ changed: 2, covered: 1, uncovered: 1, coverage: 50 });
    const math = result.files.find(file => file.file === 'src/math.js');
    expect(math.uncoveredLines).toEqual([5]);
    expect(math.coveredLines).toEqual([2]);
    expect(math.uncovered).toEqual([{ line: 5, text: '  return a - b;' }]);
    expect(result.summary).toContain('FAILED');
    expect(result.summary).toContain('return a - b');
    const report = fs.readFileSync(path.join(root, 'coverage', 'mo3ta-coverage-report.md'), 'utf8');
    expect(report).toContain('src/math.js');
    expect(report).toContain('50.00%');
  });

  it('fails clearly when Jest is not installed and tests were requested', () => {
    root = initRepo('mo3ta-no-jest-');
    writeMathFeature(root);

    expect(() => checkChangedLineCoverage({
      root,
      base: 'main',
      files: ['src/math.js'],
      runTests: true,
      useConfig: false
    })).toThrow(Mo3taError);

    try {
      checkChangedLineCoverage({
        root,
        base: 'main',
        files: ['src/math.js'],
        runTests: true,
        useConfig: false
      });
    } catch (error) {
      expect(error.code).toBe('JEST_NOT_FOUND');
      expect(error.hint).toMatch(/node_modules\/jest/);
    }
  });

  it('does not run Jest when no test file is selected', () => {
    root = initRepo('mo3ta-no-tests-');

    const result = checkChangedLineCoverage({
      root,
      base: 'main',
      files: ['src/keep.js'],
      mode: 'fast',
      runTests: true,
      useConfig: false
    });

    expect(result.ok).toBe(false);
    expect(result.testsNotRunReason).toBe('no-tests');
    expect(result.cliWouldExit).toBe(0);
    expect(result.jest.ran).toBe(false);
    expect(result.summary).toMatch(/exit 0/);
  });

  it('reports a missing lcov file instead of crashing', () => {
    root = initRepo('mo3ta-no-lcov-');
    writeMathFeature(root);

    expect(() => checkChangedLineCoverage({
      root,
      base: 'main',
      files: ['src/math.js'],
      runTests: false,
      useConfig: false
    })).toThrow(Mo3taError);

    try {
      checkChangedLineCoverage({
        root,
        base: 'main',
        files: ['src/math.js'],
        runTests: false,
        useConfig: false
      });
    } catch (error) {
      expect(error.code).toBe('LCOV_NOT_FOUND');
      expect(error.hint).toMatch(/runTests/);
    }
  });

  it('rejects an unknown mode and an out-of-range limit', () => {
    root = initRepo('mo3ta-invalid-');

    expect(() => mapRelatedTests({ root, mode: 'turbo', useConfig: false })).toThrow(Mo3taError);
    try {
      mapRelatedTests({ root, mode: 'turbo', useConfig: false });
    } catch (error) {
      expect(error.code).toBe('INVALID_MODE');
    }

    try {
      checkChangedLineCoverage({ root, limit: 140, runTests: false, useConfig: false });
      throw new Error('expected limit to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Mo3taError);
      expect(error.code).toBe('INVALID_LIMIT');
    }
  });

  it('narrowing tests with a filter keeps the pre-filter list for validation', () => {
    root = initRepo('mo3ta-filter-');
    writeMathFeature(root);

    const result = mapRelatedTests({
      root,
      base: 'main',
      files: ['src/math.js', 'src/bare.js'],
      mode: 'smart',
      filter: 'math',
      useConfig: false
    });

    expect(result.filter).toBe('math');
    expect(result.allTestsToRun).toEqual(expect.arrayContaining([
      'src/math.test.js',
      'specs/custom-name.spec.js'
    ]));
    expect(result.allTestsToRun).toHaveLength(2);
    expect(result.testsToRun).toEqual(['src/math.test.js']);
    expect(result.summary).toContain('Filter /math/ kept 1 of 2 candidate test file(s).');
  });

  it('accepts a filter default from .mo3ta-coverage.json and overrides it explicitly', () => {
    root = initRepo('mo3ta-filter-config-');
    writeMathFeature(root);
    fs.writeFileSync(path.join(root, '.mo3ta-coverage.json'), JSON.stringify({
      base: 'main',
      mode: 'smart',
      filter: 'specs/'
    }));

    const fromConfig = mapRelatedTests({ root, files: ['src/math.js'] });
    expect(fromConfig.filter).toBe('specs\\/');
    expect(fromConfig.testsToRun).toEqual([]);

    const override = mapRelatedTests({ root, files: ['src/math.js'], filter: 'math' });
    expect(override.filter).toBe('math');
    expect(override.testsToRun).toEqual(['src/math.test.js']);
  });

  it('fails fast on an invalid filter regex before running anything', () => {
    root = initRepo('mo3ta-bad-filter-');
    writeMathFeature(root);

    expect(() => mapRelatedTests({ root, base: 'main', files: ['src/math.js'], filter: '(unclosed', useConfig: false })).toThrow(Mo3taError);
    try {
      mapRelatedTests({ root, base: 'main', files: ['src/math.js'], filter: '(unclosed', useConfig: false });
    } catch (error) {
      expect(error.code).toBe('INVALID_FILTER');
      expect(error.hint).toMatch(/regular expression/i);
    }
  });
});
