import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

const CLI = path.resolve('index.js');

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
});
