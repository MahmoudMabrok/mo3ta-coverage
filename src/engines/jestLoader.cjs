'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const WORKER_PATH = path.join(__dirname, 'jestWorker.cjs');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const SUPPORTED_JEST_MAJORS = new Set([29, 30]);

/**
 * Creates an Error instance with stable `code` and optional `hint` fields.
 * @param {string} message
 * @param {string} code
 * @param {string | null} [hint]
 * @returns {Error & { code: string, hint: string | null }}
 */
function createCodedError(message, code, hint = null) {
  const err = new Error(message);
  err.code = code;
  err.hint = hint || null;
  return err;
}

/**
 * Resolves the real path of `targetPath`, or if it does not exist yet,
 * resolves the real path of its deepest existing ancestor and appends the suffix.
 * Handles macOS `/var` -> `/private/var` symlinks reliably even for non-existent paths.
 * @param {string} targetPath
 * @returns {string}
 */
function realpathOrClosest(targetPath) {
  const resolved = path.resolve(targetPath);
  const parts = [];
  let current = resolved;

  while (true) {
    try {
      if (fs.existsSync(current)) {
        const realBase = fs.realpathSync(current);
        return parts.length > 0 ? path.join(realBase, ...parts.reverse()) : realBase;
      }
    } catch {
      // Fall back to walking up or returning resolved path
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    parts.push(path.basename(current));
    current = parent;
  }
}

/**
 * Returns true if `childPath` is inside (or equal to) `parentDir`, comparing
 * real paths where possible.
 * @param {string} childPath
 * @param {string} parentDir
 * @returns {boolean}
 */
function isPathInside(childPath, parentDir) {
  if (!childPath || !parentDir) return false;
  const realChild = realpathOrClosest(childPath);
  const realParent = realpathOrClosest(parentDir);
  const rel = path.relative(realParent, realChild);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Parses a Jest semver string (e.g. "29.7.0", "30.5.2") and returns its major version number.
 * Returns `null` if the version string is missing or invalid.
 * @param {unknown} version
 * @returns {number | null}
 */
function parseJestMajorVersion(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^v?(\d+)\.\d+\.\d+(?:[-+].*)?$/i);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isInteger(major) ? major : null;
}

/**
 * Validates that a Jest version string is a supported major version (29 or 30).
 * @param {unknown} version
 * @returns {number}
 */
function assertSupportedJestVersion(version) {
  const major = parseJestMajorVersion(version);
  if (major === null || !SUPPORTED_JEST_MAJORS.has(major)) {
    throw createCodedError(
      `Unsupported Jest version "${version ?? 'unknown'}". mo3ta-coverage Jest discovery supports Jest 29 and 30.`,
      'JEST_UNSUPPORTED_VERSION',
      'Install Jest 29 or 30 in the target project, or run with --engine native.'
    );
  }
  return major;
}

function readPackageJson(pkgJsonPath, req) {
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    if (req) {
      return req(pkgJsonPath);
    }
    return null;
  }
}

function resolveFromChain(requires, moduleId) {
  let lastError = null;
  for (const req of requires) {
    if (!req || typeof req.resolve !== 'function') continue;
    try {
      return req.resolve(moduleId);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`Cannot find module '${moduleId}'`);
}

function loadFromChain(requires, moduleId) {
  let lastError = null;
  for (const req of requires) {
    if (!req || typeof req.resolve !== 'function') continue;
    try {
      const entry = req.resolve(moduleId);
      const mod = req(entry);
      return { entry, mod };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`Cannot find module '${moduleId}'`);
}

function isLeakingPackageRootModules(resolvedPath, realRoot, realPackageRoot) {
  const packageNodeModules = path.join(realPackageRoot, 'node_modules');
  const rootInsidePackage = isPathInside(realRoot, realPackageRoot);
  if (rootInsidePackage) return false;
  return isPathInside(resolvedPath, packageNodeModules);
}

/**
 * Resolves the target repo's Jest CLI binary path without leaking `mo3ta-coverage`'s
 * own `node_modules` when `root` is outside `PACKAGE_ROOT`.
 * Falls back to `<root>/node_modules/jest/bin/jest.js` when Jest is not installed.
 *
 * @param {string} [root]
 * @param {{ requireFactory?: typeof createRequire }} [options]
 * @returns {string}
 */
function resolveJestBinary(root = process.cwd(), options = {}) {
  const requireFactory = options.requireFactory || createRequire;
  const realRoot = realpathOrClosest(root);
  const realPackageRoot = realpathOrClosest(PACKAGE_ROOT);

  const directBin = path.resolve(root, 'node_modules', 'jest', 'bin', 'jest.js');
  if (fs.existsSync(directBin) && !isLeakingPackageRootModules(directBin, realRoot, realPackageRoot)) {
    return directBin;
  }

  try {
    const projectRequire = requireFactory(path.join(realRoot, 'package.json'));
    const jestPkgPath = projectRequire.resolve('jest/package.json');
    if (!isLeakingPackageRootModules(jestPkgPath, realRoot, realPackageRoot)) {
      const pkg = readPackageJson(jestPkgPath, projectRequire);
      const binRel = pkg && typeof pkg.bin === 'string'
        ? pkg.bin
        : (pkg && pkg.bin && typeof pkg.bin === 'object' && pkg.bin.jest) || 'bin/jest.js';
      return path.resolve(path.dirname(jestPkgPath), binRel);
    }
  } catch {
    // Fall through to preserving existing missing-path behavior
  }

  return directBin;
}

/**
 * Loads Jest 29/30 internal packages from the target repository's `node_modules`
 * (supporting npm, yarn, and pnpm symlinked layouts) while refusing to leak
 * `mo3ta-coverage`'s own devDependencies into external repositories.
 *
 * @param {string} [root]
 * @param {{ requireFactory?: typeof createRequire }} [options]
 */
function loadJestPackages(root = process.cwd(), options = {}) {
  const requireFactory = options.requireFactory || createRequire;
  const realRoot = realpathOrClosest(root);
  const realPackageRoot = realpathOrClosest(PACKAGE_ROOT);
  const projectRequire = requireFactory(path.join(realRoot, 'package.json'));

  let jestPkgPath;
  try {
    jestPkgPath = projectRequire.resolve('jest/package.json');
  } catch {
    throw createCodedError(
      `Jest is not installed in ${root}.`,
      'JEST_NOT_FOUND',
      'Install Jest 29 or 30 in the target repository (e.g. npm install --save-dev jest), or run with --engine native.'
    );
  }

  const realJestPkgPath = fs.existsSync(jestPkgPath) ? fs.realpathSync(jestPkgPath) : jestPkgPath;
  if (isLeakingPackageRootModules(realJestPkgPath, realRoot, realPackageRoot)) {
    throw createCodedError(
      `Jest is not installed in ${root} (refusing to use mo3ta-coverage's own Jest).`,
      'JEST_NOT_FOUND',
      'Install Jest 29 or 30 in the target repository, or run with --engine native.'
    );
  }

  const jestPkg = readPackageJson(realJestPkgPath, projectRequire);
  const version = jestPkg && jestPkg.version;
  const major = assertSupportedJestVersion(version);
  const jestBin = resolveJestBinary(root, { requireFactory });

  let jestEntry;
  try {
    jestEntry = resolveFromChain([projectRequire], 'jest');
  } catch {
    throw createCodedError(
      `Could not resolve Jest entry module in ${root}.`,
      'JEST_NOT_FOUND',
      'Reinstall Jest in the target repository, or run with --engine native.'
    );
  }

  const jestRequire = requireFactory(jestEntry);

  let jestCliMod;
  let cliRequire;
  let coreMod;
  let coreRequire;
  let configMod;
  let runtimeMod;
  let depsMod;
  let snapMod;

  try {
    const cliLoaded = loadFromChain([jestRequire, projectRequire], 'jest-cli');
    jestCliMod = cliLoaded.mod;
    cliRequire = requireFactory(cliLoaded.entry);

    const coreLoaded = loadFromChain([cliRequire, jestRequire, projectRequire], '@jest/core');
    coreMod = coreLoaded.mod;
    coreRequire = requireFactory(coreLoaded.entry);

    const packageRequires = [coreRequire, cliRequire, jestRequire, projectRequire];
    configMod = loadFromChain(packageRequires, 'jest-config').mod;
    runtimeMod = loadFromChain(packageRequires, 'jest-runtime').mod;
    depsMod = loadFromChain(packageRequires, 'jest-resolve-dependencies').mod;
    snapMod = loadFromChain(packageRequires, 'jest-snapshot').mod;
  } catch (err) {
    throw createCodedError(
      `Failed to load Jest ${version} internal packages in ${root}: ${err.message}`,
      'JEST_UNSUPPORTED_VERSION',
      'Ensure a complete Jest 29 or 30 installation exists in the target repository, or run with --engine native.'
    );
  }

  const buildArgv = jestCliMod && jestCliMod.buildArgv;
  const SearchSource = coreMod && coreMod.SearchSource;
  const readConfigs = configMod && configMod.readConfigs;
  const Runtime = (runtimeMod && runtimeMod.default) || runtimeMod;
  const DependencyResolver = depsMod && depsMod.DependencyResolver;
  const buildSnapshotResolver = snapMod && snapMod.buildSnapshotResolver;
  const isSnapshotPath = snapMod && snapMod.isSnapshotPath;

  const requiredFns = [
    ['jest-cli.buildArgv', buildArgv],
    ['jest-config.readConfigs', readConfigs],
    ['jest-runtime.Runtime', Runtime],
    ['jest-runtime.Runtime.createContext', Runtime && Runtime.createContext],
    ['jest-resolve-dependencies.DependencyResolver', DependencyResolver],
    ['@jest/core.SearchSource', SearchSource],
    ['jest-snapshot.buildSnapshotResolver', buildSnapshotResolver],
    ['jest-snapshot.isSnapshotPath', isSnapshotPath]
  ];

  const missing = requiredFns.filter(([, fn]) => typeof fn !== 'function').map(([name]) => name);
  if (missing.length > 0) {
    throw createCodedError(
      `Jest ${version} in ${root} is missing required discovery APIs: ${missing.join(', ')}.`,
      'JEST_UNSUPPORTED_VERSION',
      'Use Jest 29 or 30, or switch to --engine native.'
    );
  }

  return {
    version,
    major,
    jestBin,
    buildArgv,
    readConfigs,
    Runtime,
    DependencyResolver,
    SearchSource,
    buildSnapshotResolver,
    isSnapshotPath
  };
}

module.exports = {
  WORKER_PATH,
  PACKAGE_ROOT,
  SUPPORTED_JEST_MAJORS,
  createCodedError,
  isPathInside,
  parseJestMajorVersion,
  assertSupportedJestVersion,
  resolveJestBinary,
  loadJestPackages
};
