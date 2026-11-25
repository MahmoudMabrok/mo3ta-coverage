import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './createServer.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function git(repo, command) {
  execSync(command, { cwd: repo, stdio: 'pipe' });
}

function initFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-mcp-'));
  git(root, 'git init -b main -q');
  git(root, 'git config user.email test@example.com');
  git(root, 'git config user.name Test');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'keep.js'), 'module.exports = { keep: 1 };\n');
  git(root, 'git add src/keep.js && git commit -q -m base');
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
    "test('adds', () => {",
    '  expect(add(1, 2)).toBe(3);',
    '});',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'mo3ta-mcp-fixture',
    jest: {
      testEnvironment: 'node',
      transform: {},
      coverageReporters: ['lcov', 'text-summary']
    }
  }));
  git(root, 'git add src/math.js src/math.test.js package.json && git commit -q -m feature');
  return root;
}

async function connect() {
  const server = createServer({ version: 'test' });
  const client = new Client({ name: 'mo3ta-mcp-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

function dataOf(result) {
  assert.ok(result.structuredContent, 'tool result should include structuredContent');
  return result.structuredContent;
}

test('registers the coverage tools', async () => {
  const session = await connect();
  try {
    const listed = await session.client.listTools();
    const names = listed.tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
      'check_changed_line_coverage',
      'list_changed_files',
      'map_related_tests'
    ]);
    const check = listed.tools.find(tool => tool.name === 'check_changed_line_coverage');
    assert.match(check.description, /uncovered/);
  } finally {
    await session.close();
  }
});

test('list and map tools return changed files and their tests', async () => {
  const root = initFixture();
  const session = await connect();
  try {
    const listed = await session.client.callTool({
      name: 'list_changed_files',
      arguments: { root, base: 'main', useConfig: false }
    });
    const listedData = dataOf(listed);
    assert.equal(listed.isError, false);
    assert.deepEqual(listedData.sourceFiles, ['src/math.js']);
    assert.deepEqual(listedData.testFiles, ['src/math.test.js']);
    assert.match(listed.content[0].text, /src\/math\.js/);

    const mapped = await session.client.callTool({
      name: 'map_related_tests',
      arguments: { root, base: 'main', mode: 'fast', useConfig: false }
    });
    const mappedData = dataOf(mapped);
    assert.equal(mappedData.testsToRun.includes('src/math.test.js'), true);
    assert.match(mappedData.summary, /math\.test\.js/);
  } finally {
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('turns a missing repo and a bad base ref into tool errors', async () => {
  const session = await connect();
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-mcp-missing-'));
  fs.rmSync(missing, { recursive: true, force: true });
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-mcp-notgit-'));
  try {
    const missingResult = await session.client.callTool({
      name: 'list_changed_files',
      arguments: { root: missing, useConfig: false }
    });
    assert.equal(missingResult.isError, true);
    assert.equal(dataOf(missingResult).code, 'REPO_NOT_FOUND');

    const notGitResult = await session.client.callTool({
      name: 'list_changed_files',
      arguments: { root: notGit, useConfig: false }
    });
    assert.equal(notGitResult.isError, true);
    assert.equal(dataOf(notGitResult).code, 'NOT_A_GIT_REPO');
    assert.match(dataOf(notGitResult).hint, /checkout/);

    const root = initFixture();
    try {
      const badBase = await session.client.callTool({
        name: 'map_related_tests',
        arguments: { root, base: 'no-such-ref', useConfig: false }
      });
      assert.equal(badBase.isError, true);
      assert.equal(dataOf(badBase).code, 'INVALID_BASE_REF');
      assert.match(dataOf(badBase).hint, /git fetch/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    await session.close();
    fs.rmSync(notGit, { recursive: true, force: true });
  }
});

test('check_changed_line_coverage runs Jest and returns the uncovered line', async () => {
  const root = initFixture();
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const session = await connect();
  try {
    const result = await session.client.callTool({
      name: 'check_changed_line_coverage',
      arguments: {
        root,
        base: 'main',
        mode: 'fast',
        limit: 100,
        useConfig: false,
        timeoutMs: 120000,
        jest: ['--silent']
      }
    });
    const data = dataOf(result);
    assert.equal(result.isError, false);
    assert.deepEqual(data.jestArgs, ['--silent']);
    assert.equal(data.testsFailed, false);
    assert.equal(data.jest.ran, true);
    assert.equal(data.coveragePassed, false);
    assert.equal(data.ok, false);
    const math = data.files.find(file => file.file === 'src/math.js');
    assert.ok(math, 'expected src/math.js in the coverage result');
    assert.ok(
      math.uncovered.some(snippet => snippet.text.includes('return a - b')),
      `expected the untested sub() line in uncovered snippets, got ${JSON.stringify(math.uncovered)}`
    );
    assert.match(data.summary, /FAILED/);
    assert.match(data.summary, /return a - b/);
  } finally {
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check_changed_line_coverage reports a missing Jest install', async () => {
  const root = initFixture();
  const session = await connect();
  try {
    const result = await session.client.callTool({
      name: 'check_changed_line_coverage',
      arguments: { root, base: 'main', mode: 'fast', useConfig: false }
    });
    assert.equal(result.isError, true);
    assert.equal(dataOf(result).code, 'JEST_NOT_FOUND');
    assert.match(dataOf(result).hint, /npm|dependencies|node_modules/i);
  } finally {
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stops a Jest run that exceeds timeoutMs', async () => {
  const root = initFixture();
  fs.writeFileSync(path.join(root, 'src', 'math.test.js'), [
    "const { add } = require('./math');",
    "test('slow', () => {",
    '  const start = Date.now();',
    '  while (Date.now() - start < 20000) {}',
    '  expect(add(1, 1)).toBe(2);',
    '});',
    ''
  ].join('\n'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const session = await connect();
  try {
    const result = await session.client.callTool({
      name: 'check_changed_line_coverage',
      arguments: {
        root,
        base: 'main',
        files: ['src/math.js'],
        mode: 'fast',
        useConfig: false,
        timeoutMs: 2000
      }
    });
    assert.equal(result.isError, true);
    assert.equal(dataOf(result).code, 'JEST_TIMEOUT');
    assert.match(dataOf(result).hint, /timeoutMs/);
  } finally {
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the stdio entry does not write protocol output before a client connects', async () => {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'mcp', 'server.js')], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(stdout, '');
});
