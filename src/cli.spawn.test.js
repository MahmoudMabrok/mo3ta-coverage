import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import jestLoader from './engines/jestLoader.cjs';

const CLI = path.resolve('index.js');
const { PACKAGE_ROOT } = jestLoader;

function linkFixtureNodeModules(repo) {
  const targetModules = path.join(PACKAGE_ROOT, 'node_modules');
  const fixtureModules = path.join(repo, 'node_modules');
  fs.mkdirSync(fixtureModules, { recursive: true });
  for (const entry of fs.readdirSync(targetModules)) {
    const src = path.join(targetModules, entry);
    const dest = path.join(fixtureModules, entry);
    if (entry === 'jest') {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.symlinkSync(src, dest, 'dir');
    }
  }
}

function git(repo, command) {
  execSync(command, { cwd: repo, stdio: 'pipe' });
}

function runCli(repo, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8'
  });
}

describe('CLI process behavior', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-cli-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prints help with the --dryRun example', () => {
    const result = runCli(root, ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--dryRun true --files src/a.js,src/b.ts --base main');
    expect(result.stdout).not.toContain('--dry-run');
  });

  it('lists the --jest option in help', () => {
    const result = runCli(root, ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--jest <value>');
  });

  it('lists the --filter option in help', () => {
    const result = runCli(root, ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--filter <regex>');
  });

  it('keeps only matching spec files in a dry run and logs both lists', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.js'), 'test("a", () => expect(1).toBe(1));\n');
    git(root, 'git add -A && git commit -q -m init');

    const result = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'fast', '--filter', 'does-not-match']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Filter regex');
    expect(result.stderr).toContain('src/a.test.js');
    expect(result.stderr).toContain('after filter (0)');
  });

  it('runs only the matching spec in a real dry run and exits 0', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.js'), 'test("a", () => expect(1).toBe(1));\n');
    git(root, 'git add -A && git commit -q -m init');

    const result = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'fast', '--filter', 'a\\.test\\.js']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('src/a.test.js');
    expect(result.stderr).toContain('before filter (1)');
    expect(result.stderr).toContain('after filter (1)');
  });

  it('exits 1 with a clear message when the filter regex is invalid', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
    git(root, 'git add -A && git commit -q -m init');

    const result = runCli(root, ['--files', 'src/a.js', '--base', 'main', '--mode', 'fast', '--filter', '(unclosed']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid filter regex "(unclosed"');
  });

  it('shows the provided jest flags in the options summary', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.js'), 'test("a", () => expect(1).toBe(1));\n');
    git(root, 'git add -A && git commit -q -m init');

    const result = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'fast', '--jest', '--maxWorkers=2', '--jest', '--silent']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('--maxWorkers=2');
    expect(result.stderr).toContain('--silent');
  });

  it('reads a comma-separated jest flag list into separate flags', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.js'), 'test("a", () => expect(1).toBe(1));\n');
    git(root, 'git add -A && git commit -q -m init');

    const result = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'fast', '--jest', '--maxWorkers=2,--silent']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('--maxWorkers=2');
    expect(result.stderr).toContain('--silent');
  });

  it('dryRun prints only the selected test path on stdout', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, 'git add README.md && git commit -q -m base');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.js'), 'test("a", () => expect(1).toBe(1));\n');

    const result = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'fast']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('src/a.test.js');
    expect(result.stderr).not.toMatch(/^src\/a\.test\.js$/m);
  });

  it('exits 1 with the existing message when the directory is not a git repo', () => {
    const result = runCli(root, ['--base', 'main']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('❌ Not a git repository. Please run this tool inside a git repo.');
  });

  it('exits 1 with the existing message when the base ref is missing', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, 'git add README.md && git commit -q -m base');

    const result = runCli(root, ['--base', 'origin/missing']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('❌ Base branch "origin/missing" does not exist or is invalid. try git fetch to update your local branches.');
  });

  it('exits 1 with a parse error when .mo3ta-coverage.json is not valid JSON', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git(root, 'git add README.md && git commit -q -m base');
    fs.writeFileSync(path.join(root, '.mo3ta-coverage.json'), '{');

    const result = runCli(root, ['config']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not parse');
    expect(result.stderr).toContain('.mo3ta-coverage.json');
  });

  it('lists --engine, --discoveryWorkers, --explain, and --fallback in --help', () => {
    const result = runCli(root, ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--engine <engine>');
    expect(result.stdout).toContain('--discoveryWorkers <number>');
    expect(result.stdout).toContain('--explain [bool]');
    expect(result.stdout).toContain('--fallback <policy>');
  });

  it('persists --engine, --discoveryWorkers, and --fallback in config and rejects invalid values', () => {
    const valid = runCli(root, ['config', '--engine', 'jest', '--discoveryWorkers', '3', '--fallback', 'native']);
    expect(valid.status).toBe(0);

    const saved = JSON.parse(fs.readFileSync(path.join(root, '.mo3ta-coverage.json'), 'utf8'));
    expect(saved.engine).toBe('jest');
    expect(saved.discoveryWorkers).toBe(3);
    expect(saved.fallback).toBe('native');

    expect(runCli(root, ['config', '--engine', 'invalid']).status).toBe(1);
    expect(runCli(root, ['config', '--discoveryWorkers', '0']).status).toBe(1);
    expect(runCli(root, ['config', '--discoveryWorkers', '17']).status).toBe(1);
    expect(runCli(root, ['config', '--discoveryWorkers', '1.5']).status).toBe(1);
    expect(runCli(root, ['config', '--fallback', 'ignore']).status).toBe(1);
  });

  it('enforces CLI > config precedence and mode + engine rules', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.js'), 'test("a", () => expect(1).toBe(1));\n');
    git(root, 'git add -A && git commit -q -m init');
    fs.writeFileSync(path.join(root, '.mo3ta-coverage.json'), JSON.stringify({ engine: 'jest', fallback: 'error' }, null, 2));

    // CLI --engine native overrides saved engine: 'jest'
    const cliOverride = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'smart', '--engine', 'native']);
    expect(cliOverride.status).toBe(0);
    expect(cliOverride.stdout.trim()).toBe('src/a.test.js');

    // Saved engine: 'jest' is ignored when --mode fast is explicitly selected
    const savedIgnoredInFast = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'fast']);
    expect(savedIgnoredInFast.status).toBe(0);
    expect(savedIgnoredInFast.stdout.trim()).toBe('src/a.test.js');

    // Explicit --engine jest with --mode fast exits 1
    const explicitInvalid = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'fast', '--engine', 'jest']);
    expect(explicitInvalid.status).toBe(1);
    expect(explicitInvalid.stderr).toContain('--engine jest is only supported in smart mode (got mode: fast).');
  });

  it('keeps --dryRun stdout strictly clean even when jest.config.js logs during discovery', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'noisy-repo', private: true }, null, 2));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'specs'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'exports.a = () => 1;\n');
    fs.writeFileSync(path.join(root, 'specs', 'custom.spec.js'), "const { a } = require('../src/a');\ntest('a', () => expect(a()).toBe(1));\n");
    fs.writeFileSync(
      path.join(root, 'jest.config.js'),
      "console.log('NOISY CONFIG');\nmodule.exports = { testMatch: ['**/specs/**/*.spec.js'] };\n"
    );
    git(root, 'git add -A && git commit -q -m init');
    linkFixtureNodeModules(root);

    const result = runCli(root, [
      '--dryRun', 'true',
      '--files', 'src/a.js',
      '--base', 'main',
      '--mode', 'smart',
      '--engine', 'jest',
      '--explain', 'true'
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('specs/custom.spec.js');
    expect(result.stdout).not.toContain('NOISY CONFIG');
    expect(result.stderr).toContain('Dependency explanations');
  });

  it('errors when Jest is missing under --fallback error and warns + succeeds under --fallback native', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'no-jest-repo', private: true }, null, 2));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'a.test.js'), 'test("a", () => expect(1).toBe(1));\n');
    git(root, 'git add -A && git commit -q -m init');

    const failResult = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'smart', '--engine', 'jest']);
    expect(failResult.status).toBe(1);
    expect(failResult.stderr).toContain('Jest is not installed');

    const fallbackResult = runCli(root, ['--dryRun', 'true', '--files', 'src/a.js', '--base', 'main', '--mode', 'smart', '--engine', 'jest', '--fallback', 'native']);
    expect(fallbackResult.status).toBe(0);
    expect(fallbackResult.stdout.trim()).toBe('src/a.test.js');
    expect(fallbackResult.stderr).toContain('falling back to native engine');
  });

  it('executes Jest end-to-end with --engine jest, --runTestsByPath, and verifies changed-line coverage', () => {
    git(root, 'git init -b main -q');
    git(root, 'git config user.email test@example.com');
    git(root, 'git config user.name Test');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'e2e-jest-repo', private: true }, null, 2));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'specs'));
    fs.writeFileSync(path.join(root, 'src', 'math.js'), 'exports.add = (a, b) => a + b;\n');
    fs.writeFileSync(
      path.join(root, 'specs', 'math.spec.js'),
      "const math = require('@app/math');\ntest('adds and subs', () => { expect(math.add(1, 2)).toBe(3); if (math.sub) expect(math.sub(5, 2)).toBe(3); });\n"
    );
    fs.writeFileSync(
      path.join(root, 'jest.config.js'),
      "module.exports = { testMatch: ['**/specs/**/*.spec.js'], moduleNameMapper: { '^@app/(.*)$': '<rootDir>/src/$1' }, coverageReporters: ['lcov', 'text'] };\n"
    );
    git(root, 'git add -A && git commit -q -m init');
    git(root, 'git checkout -q -b feature');

    // Modify ONLY src/math.js on the feature branch (aliases @app/math -> only Jest discovery resolves this!)
    fs.writeFileSync(
      path.join(root, 'src', 'math.js'),
      'exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n'
    );

    linkFixtureNodeModules(root);

    const result = runCli(root, [
      '--base', 'main',
      '--mode', 'smart',
      '--engine', 'jest',
      '--explain', 'true',
      '--limit', '100'
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--runTestsByPath');
    expect(result.stdout).toContain('specs/math.spec.js');
    expect(result.stdout).toContain('smart (jest engine, depth ≤ 2, Jest 30.');
    expect(result.stdout).toContain('Overall coverage for all changed lines: 100.00%');
  });
});
