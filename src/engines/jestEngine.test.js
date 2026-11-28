import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jestLoader from './jestLoader.cjs';
import {
  INCOMPATIBLE_JEST_FLAGS,
  extractDiscoveryJestArgs,
  resolveJestPlan,
  runJestDiscovery,
  validateJestEngineFlags
} from './jestEngine.js';

const {
  PACKAGE_ROOT,
  WORKER_PATH,
  assertSupportedJestVersion,
  isPathInside,
  loadJestPackages,
  parseJestMajorVersion,
  resolveJestBinary
} = jestLoader;

const createdDirs = [];

function createTempDir(prefix = 'mo3ta-jest-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function writeFiles(root, fileMap) {
  for (const [relPath, content] of Object.entries(fileMap)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }
}

function createJestFixture(fileMap, { linkNodeModules = true } = {}) {
  const root = createTempDir('mo3ta-jest-fixture-');
  const defaultPackageJson = JSON.stringify({ name: 'fixture-repo', private: true }, null, 2);
  writeFiles(root, {
    'package.json': defaultPackageJson,
    ...fileMap
  });
  if (linkNodeModules) {
    const targetModules = path.join(PACKAGE_ROOT, 'node_modules');
    const fixtureModules = path.join(root, 'node_modules');
    fs.mkdirSync(fixtureModules, { recursive: true });
    for (const entry of fs.readdirSync(targetModules)) {
      const src = path.join(targetModules, entry);
      const dest = path.join(fixtureModules, entry);
      if (entry === 'jest') {
        // Copy the tiny `jest` wrapper package so realpath(jest/package.json) stays inside the fixture
        // rather than triggering jestLoader's PACKAGE_ROOT leak guard.
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.symlinkSync(src, dest, 'dir');
      }
    }
  }
  return root;
}

function toPosixRelative(root, filePath) {
  const realRoot = fs.realpathSync(root);
  const realFile = fs.existsSync(filePath) ? fs.realpathSync(filePath) : path.resolve(realRoot, filePath);
  return path.relative(realRoot, realFile).replace(/\\/g, '/');
}

function makeMockRequireFactory({
  jestVersion = '29.7.0',
  bin = 'bin/jest.js',
  pnpmLayout = false,
  missingExport = null,
  leakFromPackageRoot = false
} = {}) {
  const fakeRoot = pnpmLayout ? '/virtual/repo/.pnpm/jest@29.7.0/node_modules' : '/virtual/repo/node_modules';
  const jestPkgPath = leakFromPackageRoot
    ? path.join(PACKAGE_ROOT, 'node_modules', 'jest', 'package.json')
    : `${fakeRoot}/jest/package.json`;
  const jestEntry = `${fakeRoot}/jest/build/index.js`;
  const cliEntry = `${fakeRoot}/jest-cli/build/index.js`;
  const coreEntry = `${fakeRoot}/@jest/core/build/index.js`;
  const configEntry = `${fakeRoot}/jest-config/build/index.js`;
  const runtimeEntry = `${fakeRoot}/jest-runtime/build/index.js`;
  const depsEntry = `${fakeRoot}/jest-resolve-dependencies/build/index.js`;
  const snapEntry = `${fakeRoot}/jest-snapshot/build/index.js`;

  class FakeRuntime {
    static createContext() {}
  }
  class FakeDependencyResolver {}
  class FakeSearchSource {}

  const modules = {
    [jestPkgPath]: { name: 'jest', version: jestVersion, bin },
    [jestEntry]: {},
    [cliEntry]: { buildArgv: () => {} },
    [coreEntry]: missingExport === 'SearchSource' ? {} : { SearchSource: FakeSearchSource },
    [configEntry]: { readConfigs: () => {} },
    [runtimeEntry]: { default: FakeRuntime },
    [depsEntry]: { DependencyResolver: FakeDependencyResolver },
    [snapEntry]: { buildSnapshotResolver: () => {}, isSnapshotPath: () => false }
  };

  function makeReq(fromFile) {
    const req = (id) => {
      if (modules[id]) return modules[id];
      const resolved = req.resolve(id);
      return modules[resolved];
    };

    req.resolve = (id) => {
      if (id === 'jest/package.json') return jestPkgPath;
      if (id === 'jest') return jestEntry;

      if (pnpmLayout) {
        if (fromFile === jestEntry && id === 'jest-cli') return cliEntry;
        if (fromFile === cliEntry && id === '@jest/core') return coreEntry;
        if (fromFile === coreEntry && id === 'jest-config') return configEntry;
        if (fromFile === coreEntry && id === 'jest-runtime') return runtimeEntry;
        if (fromFile === coreEntry && id === 'jest-resolve-dependencies') return depsEntry;
        if (fromFile === coreEntry && id === 'jest-snapshot') return snapEntry;
        const err = new Error(`Cannot find module '${id}' from '${fromFile}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }

      const map = {
        'jest-cli': cliEntry,
        '@jest/core': coreEntry,
        'jest-config': configEntry,
        'jest-runtime': runtimeEntry,
        'jest-resolve-dependencies': depsEntry,
        'jest-snapshot': snapEntry
      };
      if (map[id]) return map[id];
      const err = new Error(`Cannot find module '${id}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    };

    return req;
  }

  return makeReq;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('jestLoader', () => {
  test('exposes WORKER_PATH and PACKAGE_ROOT without import.meta.url', () => {
    expect(fs.existsSync(WORKER_PATH)).toBe(true);
    expect(path.basename(WORKER_PATH)).toBe('jestWorker.cjs');
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'package.json'))).toBe(true);
  });

  test('parseJestMajorVersion and assertSupportedJestVersion validate Jest 29 and 30', () => {
    expect(parseJestMajorVersion('29.7.0')).toBe(29);
    expect(parseJestMajorVersion('30.5.2')).toBe(30);
    expect(parseJestMajorVersion('30.0.0-alpha.1')).toBe(30);
    expect(parseJestMajorVersion('')).toBeNull();
    expect(parseJestMajorVersion('latest')).toBeNull();
    expect(parseJestMajorVersion(null)).toBeNull();

    expect(assertSupportedJestVersion('29.7.0')).toBe(29);
    expect(assertSupportedJestVersion('30.5.2')).toBe(30);

    for (const badVersion of ['28.1.3', '31.0.0', 'invalid']) {
      let caught;
      try {
        assertSupportedJestVersion(badVersion);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.code).toBe('JEST_UNSUPPORTED_VERSION');
      expect(caught.hint).toBeTruthy();
    }
  });

  test('isPathInside handles nested, equal, sibling, and ..-prefixed directories', () => {
    const base = createTempDir('mo3ta-inside-');
    const child = path.join(base, 'a', 'b');
    const sibling = path.join(base, 'sibling');
    const dotdotSibling = `${base}..extra`;
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });

    expect(isPathInside(child, base)).toBe(true);
    expect(isPathInside(base, base)).toBe(true);
    expect(isPathInside(sibling, path.join(base, 'a'))).toBe(false);
    expect(isPathInside(dotdotSibling, base)).toBe(false);
  });

  test('resolveJestBinary resolves local Jest, mocked bin layouts, and refuses PACKAGE_ROOT leak', () => {
    const emptyRepo = createJestFixture({}, { linkNodeModules: false });
    expect(resolveJestBinary(emptyRepo)).toBe(
      path.resolve(emptyRepo, 'node_modules', 'jest', 'bin', 'jest.js')
    );

    const linkedRepo = createJestFixture({}, { linkNodeModules: true });
    expect(resolveJestBinary(linkedRepo)).toBe(
      path.resolve(linkedRepo, 'node_modules', 'jest', 'bin', 'jest.js')
    );

    const pnpmBin = resolveJestBinary(emptyRepo, {
      requireFactory: makeMockRequireFactory({ bin: { jest: 'cli/jest.js' }, pnpmLayout: true })
    });
    expect(pnpmBin).toBe(path.resolve('/virtual/repo/.pnpm/jest@29.7.0/node_modules/jest/cli/jest.js'));

    const leakedFallback = resolveJestBinary(emptyRepo, {
      requireFactory: makeMockRequireFactory({ leakFromPackageRoot: true })
    });
    expect(leakedFallback).toBe(path.resolve(emptyRepo, 'node_modules', 'jest', 'bin', 'jest.js'));
  });

  test('loadJestPackages loads real Jest 30 from PACKAGE_ROOT', () => {
    const loaded = loadJestPackages(PACKAGE_ROOT);
    expect(loaded.major).toBe(30);
    expect(typeof loaded.buildArgv).toBe('function');
    expect(typeof loaded.readConfigs).toBe('function');
    expect(typeof loaded.Runtime).toBe('function');
    expect(typeof loaded.DependencyResolver).toBe('function');
    expect(typeof loaded.SearchSource).toBe('function');
    expect(typeof loaded.buildSnapshotResolver).toBe('function');
    expect(typeof loaded.isSnapshotPath).toBe('function');
  });

  test('loadJestPackages throws JEST_NOT_FOUND when Jest is absent or leaked from PACKAGE_ROOT', () => {
    const emptyRepo = createJestFixture({}, { linkNodeModules: false });

    expect(() => loadJestPackages(emptyRepo)).toThrow();
    try {
      loadJestPackages(emptyRepo);
    } catch (err) {
      expect(err.code).toBe('JEST_NOT_FOUND');
      expect(err.hint).toBeTruthy();
    }

    try {
      loadJestPackages(emptyRepo, {
        requireFactory: makeMockRequireFactory({ leakFromPackageRoot: true })
      });
      throw new Error('Expected JEST_NOT_FOUND');
    } catch (err) {
      expect(err.code).toBe('JEST_NOT_FOUND');
    }
  });

  test('loadJestPackages supports Jest 29 pnpm ownership chain and rejects Jest 28 or missing APIs', () => {
    const emptyRepo = createJestFixture({}, { linkNodeModules: false });

    const jest29 = loadJestPackages(emptyRepo, {
      requireFactory: makeMockRequireFactory({ jestVersion: '29.7.0', pnpmLayout: true })
    });
    expect(jest29.major).toBe(29);
    expect(jest29.version).toBe('29.7.0');

    try {
      loadJestPackages(emptyRepo, {
        requireFactory: makeMockRequireFactory({ jestVersion: '28.1.3' })
      });
      throw new Error('Expected JEST_UNSUPPORTED_VERSION');
    } catch (err) {
      expect(err.code).toBe('JEST_UNSUPPORTED_VERSION');
    }

    try {
      loadJestPackages(emptyRepo, {
        requireFactory: makeMockRequireFactory({ jestVersion: '29.7.0', missingExport: 'SearchSource' })
      });
      throw new Error('Expected JEST_UNSUPPORTED_VERSION');
    } catch (err) {
      expect(err.code).toBe('JEST_UNSUPPORTED_VERSION');
    }
  });
});

describe('jestEngine flag validation and discovery arg extraction', () => {
  test('validateJestEngineFlags rejects every incompatible flag with INVALID_JEST_FLAG_FOR_ENGINE', () => {
    for (const flag of INCOMPATIBLE_JEST_FLAGS) {
      expect(() => validateJestEngineFlags([flag])).toThrow();
      try {
        validateJestEngineFlags([`${flag}=true`]);
      } catch (err) {
        expect(err.code).toBe('INVALID_JEST_FLAG_FOR_ENGINE');
        expect(err.hint).toBeTruthy();
      }
    }

    expect(() => validateJestEngineFlags(['--watchAll=false', '--maxWorkers=2', '--config=jest.json'])).not.toThrow();
  });

  test('extractDiscoveryJestArgs extracts single-value, multi-value, and boolean discovery flags', () => {
    const extracted = extractDiscoveryJestArgs([
      '--maxWorkers=2',
      '--config',
      'configs/jest.custom.json',
      '-c=other.json',
      '--projects',
      'packages/a',
      'packages/b',
      '--selectProjects',
      'unit',
      '--ignoreProjects=e2e',
      '--testPathPatterns',
      'src/.*\\.test\\.js$',
      '--silent',
      '--no-watchman'
    ]);

    expect(extracted).toEqual([
      '--config',
      'configs/jest.custom.json',
      '-c=other.json',
      '--projects',
      'packages/a',
      'packages/b',
      '--selectProjects',
      'unit',
      '--ignoreProjects=e2e',
      '--testPathPatterns',
      'src/.*\\.test\\.js$',
      '--no-watchman'
    ]);
  });
});

describe('resolveJestPlan and jestWorker integration with Jest 30', () => {
  test('resolves moduleNameMapper aliases, __mocks__, and snapshot files', () => {
    const root = createJestFixture({
      'jest.config.json': JSON.stringify({
        testEnvironment: 'node',
        moduleNameMapper: {
          '^@utils/(.*)$': '<rootDir>/src/utils/$1'
        }
      }),
      'src/utils/math.js': 'exports.add = (a, b) => a + b;\n',
      'src/service.js': 'exports.fetchData = () => "real";\n',
      'src/__mocks__/service.js': 'exports.fetchData = () => "mock";\n',
      'src/alias.test.js': 'const { add } = require("@utils/math"); test("add", () => expect(add(1, 2)).toBe(3));\n',
      'src/mocked.test.js': 'jest.mock("./service"); const svc = require("./service"); test("svc", () => expect(svc.fetchData()).toBe("mock"));\n',
      'src/widget.test.js': 'test("snap", () => expect("hi").toMatchSnapshot());\n',
      'src/__snapshots__/widget.test.js.snap': '// Jest Snapshot v1\nexports[`snap 1`] = `"hi"`;\n'
    });

    const aliasPlan = resolveJestPlan({
      root,
      files: ['src/utils/math.js'],
      depth: 1,
      explain: true
    });
    expect(aliasPlan.engine).toBe('jest');
    expect(aliasPlan.jestVersion).toMatch(/^30\./);
    expect(aliasPlan.testsToRun).toEqual(['src/alias.test.js']);
    expect(aliasPlan.jestArgs).toEqual([
      '--passWithNoTests',
      '--coverage',
      '--runTestsByPath',
      'src/alias.test.js'
    ]);
    expect(aliasPlan.explanation).toEqual([
      {
        source: 'src/utils/math.js',
        test: 'src/alias.test.js',
        depth: 1,
        path: ['src/utils/math.js', 'src/alias.test.js'],
        projectName: null
      }
    ]);

    const mockPlan = resolveJestPlan({
      root,
      files: ['src/__mocks__/service.js'],
      depth: 1
    });
    expect(mockPlan.testsToRun).toEqual(['src/mocked.test.js']);

    const snapPlan = resolveJestPlan({
      root,
      files: ['src/__snapshots__/widget.test.js.snap'],
      depth: 0
    });
    expect(snapPlan.testsToRun).toEqual(['src/widget.test.js']);
  });

  test('enforces depth = 0, 1, 2, Infinity and achieves exact parity with jest --findRelatedTests at Infinity', () => {
    const root = createJestFixture({
      'jest.config.json': JSON.stringify({ testEnvironment: 'node' }),
      'src/leaf.js': 'exports.x = 1;\n',
      'src/mid.js': 'const leaf = require("./leaf"); exports.y = leaf.x + 1;\n',
      'src/top.js': 'const mid = require("./mid"); exports.z = mid.y + 1;\n',
      'src/leaf.test.js': 'const leaf = require("./leaf"); test("leaf", () => expect(leaf.x).toBe(1));\n',
      'src/mid.test.js': 'const mid = require("./mid"); test("mid", () => expect(mid.y).toBe(2));\n',
      'src/top.test.js': 'const top = require("./top"); test("top", () => expect(top.z).toBe(3));\n'
    });

    const d0 = resolveJestPlan({ root, files: ['src/leaf.js'], depth: 0 });
    expect(d0.testsToRun).toEqual([]);
    expect(d0.jestArgs).toEqual([]);

    const d1 = resolveJestPlan({ root, files: ['src/leaf.js'], depth: 1 });
    expect(d1.testsToRun).toEqual(['src/leaf.test.js']);

    const d2 = resolveJestPlan({ root, files: ['src/leaf.js'], depth: 2 });
    expect(d2.testsToRun).toEqual(['src/leaf.test.js', 'src/mid.test.js']);

    const dInf = resolveJestPlan({ root, files: ['src/leaf.js'], depth: Infinity });
    expect(dInf.testsToRun).toEqual(['src/leaf.test.js', 'src/mid.test.js', 'src/top.test.js']);

    const jestBin = resolveJestBinary(root);
    const stdout = execFileSync(
      process.execPath,
      [jestBin, '--findRelatedTests', 'src/leaf.js', '--listTests', '--json', '--watchman=false'],
      { cwd: root, encoding: 'utf8' }
    );
    const jestFoundTests = JSON.parse(stdout)
      .map(abs => toPosixRelative(root, abs))
      .sort();

    expect(dInf.testsToRun).toEqual(jestFoundTests);
  });

  test('classifies custom testMatch files at depth 0 and applies filter regex', () => {
    const root = createJestFixture({
      'jest.config.json': JSON.stringify({
        testEnvironment: 'node',
        testMatch: ['**/__specs__/*.check.js', '**/*.test.js']
      }),
      'src/core.js': 'exports.ok = true;\n',
      'src/__specs__/alpha.check.js': 'const core = require("../core"); test("a", () => expect(core.ok).toBe(true));\n',
      'src/__specs__/beta.check.js': 'const core = require("../core"); test("b", () => expect(core.ok).toBe(true));\n'
    });

    const customTestPlan = resolveJestPlan({
      root,
      files: ['src/__specs__/alpha.check.js'],
      depth: 2
    });
    expect(customTestPlan.testFiles).toEqual(['src/__specs__/alpha.check.js']);
    expect(customTestPlan.sourceFiles).toEqual([]);
    expect(customTestPlan.testsToRun).toEqual(['src/__specs__/alpha.check.js']);

    const filteredPlan = resolveJestPlan({
      root,
      files: ['src/core.js'],
      depth: 1,
      filter: 'alpha\\.check'
    });
    expect(filteredPlan.allTestsToRun).toEqual([
      'src/__specs__/alpha.check.js',
      'src/__specs__/beta.check.js'
    ]);
    expect(filteredPlan.testsToRun).toEqual(['src/__specs__/alpha.check.js']);
    expect(filteredPlan.mappings[0].allTests).toEqual([
      'src/__specs__/alpha.check.js',
      'src/__specs__/beta.check.js'
    ]);
    expect(filteredPlan.mappings[0].tests).toEqual(['src/__specs__/alpha.check.js']);
  });

  test('supports multi-project configs, narrows named projects, and handles unnamed projects conservatively', () => {
    const namedRoot = createJestFixture({
      'jest.config.json': JSON.stringify({
        projects: [
          {
            displayName: 'unit',
            testMatch: ['<rootDir>/packages/unit/**/*.test.js']
          },
          {
            displayName: 'integration',
            testMatch: ['<rootDir>/packages/integration/**/*.test.js']
          }
        ]
      }),
      'packages/unit/a.js': 'exports.a = 1;\n',
      'packages/unit/a.test.js': 'const { a } = require("./a"); test("a", () => expect(a).toBe(1));\n',
      'packages/integration/b.js': 'exports.b = 2;\n',
      'packages/integration/b.test.js': 'const { b } = require("./b"); test("b", () => expect(b).toBe(2));\n'
    });

    const narrowedPlan = resolveJestPlan({
      root: namedRoot,
      files: ['packages/unit/a.js'],
      depth: 1
    });
    expect(narrowedPlan.testsToRun).toEqual(['packages/unit/a.test.js']);
    expect(narrowedPlan.jestArgs).toEqual([
      '--passWithNoTests',
      '--coverage',
      '--runTestsByPath',
      'packages/unit/a.test.js',
      '--selectProjects',
      'unit'
    ]);

    const explicitSelectPlan = resolveJestPlan({
      root: namedRoot,
      files: ['packages/unit/a.js'],
      depth: 1,
      jestArgs: ['--selectProjects', 'integration', 'missing-project']
    });
    expect(explicitSelectPlan.testsToRun).toEqual([]);
    expect(explicitSelectPlan.warnings.some(w => w.includes('missing-project'))).toBe(true);

    const unnamedRoot = createJestFixture({
      'jest.config.json': JSON.stringify({
        projects: [
          { testMatch: ['<rootDir>/packages/one/**/*.test.js'] },
          { testMatch: ['<rootDir>/packages/two/**/*.test.js'] }
        ]
      }),
      'packages/one/a.js': 'exports.a = 1;\n',
      'packages/one/a.test.js': 'const { a } = require("./a"); test("a", () => expect(a).toBe(1));\n',
      'packages/two/b.test.js': 'test("b", () => expect(2).toBe(2));\n'
    });

    const unnamedPlan = resolveJestPlan({
      root: unnamedRoot,
      files: ['packages/one/a.js'],
      depth: 1
    });
    expect(unnamedPlan.testsToRun).toEqual(['packages/one/a.test.js']);
    expect(unnamedPlan.jestArgs).not.toContain('--selectProjects');
    expect(unnamedPlan.warnings.some(w => w.includes('displayName'))).toBe(true);
  });

  test('warns for missing on-disk files and HasteFS-excluded files', () => {
    const root = createJestFixture({
      'jest.config.json': JSON.stringify({
        testEnvironment: 'node',
        modulePathIgnorePatterns: ['<rootDir>/ignored/']
      }),
      'ignored/secret.js': 'exports.s = 1;\n'
    });

    const plan = resolveJestPlan({
      root,
      files: ['src/missing.js', 'ignored/secret.js'],
      depth: 1
    });

    expect(plan.testsToRun).toEqual([]);
    expect(plan.jestArgs).toEqual([]);
    expect(plan.warnings.some(w => w.includes('does not exist on disk'))).toBe(true);
    expect(plan.warnings.some(w => w.includes('HasteFS'))).toBe(true);
  });

  test('surfaces structured errors for invalid config, empty project selection, missing Jest, and timeout', () => {
    const badConfigRoot = createJestFixture({
      'jest.config.js': 'module.exports = { brokenSyntax: ( };\n',
      'src/a.js': 'exports.a = 1;\n'
    });

    try {
      resolveJestPlan({ root: badConfigRoot, files: ['src/a.js'] });
      throw new Error('Expected JEST_CONFIG_ERROR');
    } catch (err) {
      expect(err.code).toBe('JEST_CONFIG_ERROR');
      expect(err.hint).toBeTruthy();
    }

    const validRoot = createJestFixture({
      'jest.config.json': JSON.stringify({
        projects: [{ displayName: 'unit', testMatch: ['**/*.test.js'] }]
      }),
      'src/a.js': 'exports.a = 1;\n'
    });

    try {
      resolveJestPlan({
        root: validRoot,
        files: ['src/a.js'],
        jestArgs: ['--selectProjects', 'nonexistent']
      });
      throw new Error('Expected JEST_CONFIG_ERROR');
    } catch (err) {
      expect(err.code).toBe('JEST_CONFIG_ERROR');
    }

    const noJestRoot = createJestFixture({ 'src/a.js': 'exports.a = 1;\n' }, { linkNodeModules: false });
    try {
      runJestDiscovery({ root: noJestRoot, files: ['src/a.js'] });
      throw new Error('Expected JEST_NOT_FOUND');
    } catch (err) {
      expect(err.code).toBe('JEST_NOT_FOUND');
      expect(err.hint).toBeTruthy();
    }

    try {
      runJestDiscovery({ root: validRoot, files: ['src/a.js'], timeoutMs: 1 });
      throw new Error('Expected JEST_DISCOVERY_TIMEOUT');
    } catch (err) {
      expect(err.code).toBe('JEST_DISCOVERY_TIMEOUT');
      expect(err.hint).toBeTruthy();
    }
  });
});
