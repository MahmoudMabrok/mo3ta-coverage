# AGENT.md

Guidance for coding agents working in this repository.

## What this project is

`mo3ta-coverage` is a Node.js CLI (published to npm) that:

1. Finds source files changed on the current branch vs a base branch.
2. Finds the test files related to those changed files.
3. Runs Jest only for those tests (or lets Jest expand them).
4. Parses `coverage/lcov.info` and checks coverage of the changed lines.

The primary use case is CI on pull requests: fail only when changed lines are not
covered enough, without running the entire test suite.

## Tech stack

- Node.js ESM (`"type": "module"`), no build step required for normal use.
- `commander` for the CLI.
- Jest 30 for this project's own tests.
- Babel (`@babel/preset-env`) only to transform JS for Jest.
- Runtime code lives in `index.js` and `src/`; `dist/` is not committed.

## Commands

```bash
npm install
npm test                    # jest --coverage

# Basic CLI run from another project
node /path/to/mo3ta-coverage/index.js --mode smart --base origin/main --limit 80

# This repository's CLI options
node index.js --help
```

There is no lint/typecheck/format script. `npm run build` currently outputs
`dist/index.js` from `index.js` only; it is not part of the normal workflow.

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.js` | CLI entry point: option parsing, config file read/write, calls `main()`. |
| `src/cli.js` | Orchestration: changed files, test selection, Jest invocation, lcov reporting. |
| `src/fileUtils.js` | File classification and changed-file → test-file mapping. |
| `src/gitUtils.js` | Git repo/base-branch validation. |
| `src/cli.test.js` | Tests for lcov parsing, changed-line classification, summaries. |
| `src/fileUtils.test.js` | Tests for file filtering, naming conventions, import scanning. |
| `jest.config.json` | Jest config: `**/src/**/*.test.js`, node env, babel-jest transform. |
| `.github/workflows/dependency-audit.yml` | Daily dependency security audit; opens/updates a tracked issue on findings. |
| `.github/scripts/audit-open-issue.mjs` | Issue manager for the audit workflow (`gh` CLI). |
| `.mo3ta-coverage.json` | Optional per-project config (gitignored here). |

## Execution flow

```text
index.js
  └─ main(options)                         src/cli.js
       ├─ verifyGitRepoExists()            src/gitUtils.js
       ├─ getExplicitFiles(options)        --files / --filesFrom, or
       ├─ getChangedFiles(base)            merge-base diff + working tree, all authors
       ├─ dryRun(files, mode, depth)       --dryRun: print the would-run test list, exit 0
        ├─ runRelatedTests(files, mode, depth)
       │    └─ npx jest ... --coverage
       └─ reportUncoveredChangedLines(...)
            ├─ parseLcov(path)
            ├─ getChangedLines(file, base) git diff -U0
            ├─ classifyChangedLineCoverage(...)
            └─ exit 1 when overall coverage < limit
```

### Changed-file detection

`getChangedFiles()` unions:

- files changed between `merge-base HEAD <base>` and `HEAD` (all authors),
- unstaged changes,
- staged changes.

It keeps only `.js/.ts/.jsx/.tsx` and drops `node_modules`, `coverage`, `dist`,
`build`, and `.git` paths. Paths are relative to `process.cwd()`.

When `--files` or `--filesFrom` is provided, `getExplicitFiles()` normalizes the
list (comma/space separated, relative or absolute, de-duplicated) and auto
detection is skipped. Changed lines for those files are still computed against
`--base`, because `git diff -U0 <base> -- <file>` drives the coverage check.

### Modes

- `fast`: naming-convention matches only (plus changed test files), with the
  existing direct import-scan fallback. No dependency traversal.
- `smart` (default): naming-convention matches **plus** a reverse-dependency
  search over the import graph, limited by `--depth` (default `2`). This finds
  spec files whose names do not match the source file and tests that reach the
  changed file through one intermediate module (for example a barrel
  `index.js`).
- `full`: passes the changed source and test files to
  `jest --findRelatedTests`, letting Jest do unbounded traversal.

Depth semantics for `smart`: one edge = an import. `--depth 1` finds test files
that import the changed file directly. `--depth 2` also finds test files that
import a module which imports the changed file.

### Coverage reporting

- `parseLcov()` absolutizes `SF:` paths.
- Changed lines are the added line numbers from `git diff -U0 <base> -- <file>`.
- Only lines present in lcov (`DA:`) are counted; imports/comments are ignored.
- The overall ratio is computed across all changed, coverable lines.
- A missing lcov file exits with code 1; below-limit coverage exits with code 1.
- `main()` wraps everything and exits 1 on unexpected errors.

## Conventions

- Use ESM `import`/`export`; no CommonJS in `src/`.
- Keep functions small, pure where possible, and exported only when tested.
- File-path logic uses `fs`/`path` and must work with both relative git paths and
  absolute lcov paths.
- Walkers skip `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`,
  `.turbo`, and dot-directories (`SKIP_DIRS` plus the dot-prefix check).
- Import parsing is regex-based (`IMPORT_SPECIFIER_RE`), intentionally
  dependency-free. It handles `import`, `export ... from`, `require`, dynamic
  `import()`, and `jest.mock()`.
- Test files are recognized by `(\.test|\.spec)\.(js|ts|jsx|tsx)$`.
- New behavior in `src/fileUtils.js` or `src/cli.js` should come with tests in
  the matching `*.test.js` file.
- Do not add runtime dependencies without a clear need; the package ships only
  `commander`.
- All dependencies in `package.json` are pinned to exact versions (no `^`/`~`);
  transitive fixes go through `overrides`. `npm audit` must be clean before
  dependency changes are merged.

## Gotchas

- `findTestFilesForSource` and `findRelatedTestFilesBySource` return paths
  relative to the scan root; `findTestFilesByImport` also accepts a `root` for
  tests using temp fixtures.
- Import-graph and test-file scans are cached per root for the lifetime of the
  process. Tests must use a fresh temp directory per fixture (they do).
- Alias resolution is heuristic: `@/` and `~/` are stripped, then the specifier
  is matched against repo-relative paths by exact match or path suffix.
  Over-matching is acceptable (it may run extra tests) but under-matching is not.
- `runRelatedTests` exits the process (`exit(0)`/`exit(1)`) rather than throwing.
- `--dryRun` must keep stdout a clean one-path-per-line list (other tools
  consume it); informational messages go to stderr.
- The config subcommand writes `.mo3ta-coverage.json` in `process.cwd()`.
- CLI options with commander defaults (`mode`, `depth`) override config unless
  you check `program.getOptionValueSource(...) === 'cli'`.
- Git and Jest are always invoked with argument arrays (`execFileSync`),
  never through a shell, so refs and file paths cannot inject commands.
  `--base` values are validated with `git rev-parse --verify` before use;
  file paths in `git diff` are protected by the `--` pathspec separator.
