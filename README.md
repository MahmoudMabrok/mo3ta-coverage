# mo3ta-coverage ![NPM Version](https://img.shields.io/npm/v/mo3ta-coverage)

![mo3ta-coverage modes and features](docs/poster.png)

mo3ta-coverage checks coverage for changed lines in a pull request. It finds changed source files, maps them to likely test files, runs Jest in a selected execution mode, and validates changed-line coverage against a threshold.

## Demo

https://github.com/user-attachments/assets/1139ca7a-69e6-4b41-ad24-ff20e083c4e0

A quick walkthrough of changed-file detection, related-test selection, and changed-line coverage.

## Features

- Detects changed JS/TS files from git history and working tree, for all authors
- Accepts an explicit file list (`--files` / `--filesFrom`) to control what gets scanned
- Maps changed source files to related test files, even when names differ
- Supports three execution modes: `fast`, `smart`, and `full`
- Walks reverse imports in `smart` mode to a configurable depth (default `2`)
- Parses `lcov.info` and reports uncovered changed lines
- Enforces a minimum coverage threshold for changed lines
- `--dryRun` lists the test files that would run (machine-readable, for other tools)

## GitHub Action

[mo3ta-coverage-action](https://github.com/MahmoudMabrok/mo3ta-coverage-action)
wraps the CLI as a reusable GitHub Action: it bundles the tool, runs it on
Node 20, and appends the markdown coverage table to the job summary
automatically.

It also auto-resolves what to diff against based on the triggering event,
so you usually don't set `base` at all:

| Event | Base used |
|-------|-----------|
| `pull_request` | the PR's exact base commit |
| `push` | the previous commit (`HEAD~1`) |
| other (schedule, dispatch) | `origin/main` |

### Minimal setup (recommended)

```yaml
# .github/workflows/changed-line-coverage.yml
name: Changed-line coverage

on:
  pull_request:
  push:
    branches: [main]

jobs:
  changed-line-coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history needed for the merge-base diff
      - run: npm ci
      - uses: MahmoudMabrok/mo3ta-coverage-action@v1
```

### Customizing

```yaml
      - uses: MahmoudMabrok/mo3ta-coverage-action@v1
        with:
          base: origin/develop  # explicit base (overrides auto-resolution)
          mode: smart           # fast | smart (default) | full
          depth: 2              # smart mode reverse-import depth
          limit: 80             # minimum changed-line coverage, %
          # ci: true            # default; clean output + markdown table
          # report-to-summary: true  # default; append table to job summary
```

All inputs, and how to scope the run to specific files (`files` /
`files-from`), are documented in the
[action README](https://github.com/MahmoudMabrok/mo3ta-coverage-action#inputs).

## Installation

```sh
npm install -g mo3ta-coverage
```

## Usage

```sh
mo3ta-coverage --mode smart --base origin/main --limit 80
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--base <branch>` | Base branch to compare against | `origin/main` |
| `--lcov <path>` | Path to `lcov.info` | `coverage/lcov.info` |
| `--limit <percent>` | Minimum changed-line coverage percentage | `80` |
| `--showCovered <bool>` | Show covered changed lines in output | `false` |
| `--mode <mode>` | Execution mode: `fast`, `smart`, or `full` | `smart` |
| `--depth <number>` | Max reverse-import depth used by `smart` (`1` or `2` recommended) | `2` |
| `--files <files...>` | Scan only these files instead of auto-detecting changed files (space- or comma-separated) | – |
| `--filesFrom <path>` | Read the file list to scan from a newline-separated file | – |
| `--ci <bool>` | CI mode: emit results as a markdown table and save it to a file so CI can read it without parsing logs | `false` |
| `--ciReport <path>` | Where to save the CI markdown table | `coverage/mo3ta-coverage-report.md` |
| `--dryRun <bool>` | Print the test files that would run (one per line) and stop, without running Jest or the coverage check | `false` |

## Scanning Selected Files

Changed files are detected from git for **all authors**, not just the current
git user. If you want to control exactly which files are scanned, pass them
directly. The library still maps them to tests and checks changed-line coverage.

```sh
# Explicit list (space-separated)
mo3ta-coverage --files src/a.js src/b.ts --base origin/main

# Explicit list (comma-separated)
mo3ta-coverage --files src/a.js,src/b.ts --base origin/main

# From a file containing one path per line
git diff --name-only origin/main > changed.txt
mo3ta-coverage --filesFrom changed.txt --base origin/main
```

Explicitly provided files skip git changed-file detection. Their changed lines
are still computed against `--base`, so only lines that differ from the base
branch are counted toward coverage.

## CI Mode

Pass `--ci true` to print the coverage results as a markdown table **and**
save that same table to a file (default: `coverage/mo3ta-coverage-report.md`,
configurable with `--ciReport`), so a CI job can read only the table instead
of parsing through the logs:

```sh
mo3ta-coverage --mode smart --base origin/main --ci true
# or save the table elsewhere
mo3ta-coverage --ci true --ciReport report.md
```

The table includes a per-file breakdown plus an **Overall** row with the
overall coverage percentage, and a summary line showing the limit. The exit
code is unchanged: the run still fails when changed-line coverage is below
`--limit`. In CI mode the verbose per-file console output is replaced by the
markdown table.

If you use the
[GitHub Action](https://github.com/MahmoudMabrok/mo3ta-coverage-action),
`--ci` is enabled for you and the table is appended to the job summary
automatically — no `run:` step needed.

## Dry Run (list test files for other tools)

Pass `--dryRun true` to stop after test discovery and print the test files
that the run *would* execute, one path per line, on stdout — without running
Jest and without the coverage check. This makes the tool's test selection
available to any other tool (e.g. a watch task or another coverage runner):

```sh
mo3ta-coverage --mode smart --base origin/main --dryRun true
```

stdout contains only the file list (repo-relative paths, one per line);
all human-readable diagnostics go to stderr, so `--dryRun` output is safe
to pipe or capture:

```sh
# Feed the discovered tests to another tool
mo3ta-coverage --base origin/main --dryRun true | xargs -n 1 npx jest --silent

# Combine with an explicit file list
mo3ta-coverage --files src/a.js,src/b.ts --base origin/main --dryRun true
```

Notes:

- Discovery follows the selected `--mode` (default `smart`), so the list
  matches exactly what a normal run would execute.
- `--dryRun` still needs a `--base` (changed files are computed against it),
  but does not need a valid `lcov.info` or a local Jest install.
- In `full` mode discovery is delegated to Jest's `--findRelatedTests`, so
  `--dryRun` can only list the changed test files themselves (a warning is
  printed to stderr).

### Example output

On the demo app, a PR touching `src/ops.js`, the `src/math.js` barrel, and
`src/math.spec.js` selects exactly one test file:

```console
$ mo3ta-coverage --base origin/main --mode smart --dryRun true
src/math.spec.js
```

`src/ops.js` has no same-name spec, but it is re-exported by the
`src/math.js` barrel and `src/math.spec.js` imports that barrel, so the
reverse-import walk finds it at depth 2. Only the selected path reaches
stdout; the diagnostics (changed files, mode, depth) go to stderr.

## Modes

- `fast`: Naming-convention matches only, plus a direct import-scan fallback. No dependency traversal.
- `smart`: Naming-convention matches plus a reverse-import walk from each changed file, limited by `--depth`. This finds spec files whose names differ and tests that reach the changed file through intermediate modules such as barrel `index.js` files. No Jest dependency traversal.
- `full`: Passes the changed source and test files to `jest --findRelatedTests`, letting Jest traverse without a depth limit.

### Depth in `smart` mode

One depth step is one import edge:

- `--depth 1`: test files that import the changed file directly.
- `--depth 2` (default): also test files that import a module which imports the changed file.

Depth `2` is usually the sweet spot: it catches barrel/re-export and thin wrapper
layers without pulling in the whole dependency graph.

## Recommended Mode

For most projects, especially large ones with shared helpers or deep import graphs, use:

```sh
mo3ta-coverage --mode smart --base origin/main --limit 80
```

Use `full` only when you intentionally want Jest to expand to related tests.

## Configuration

You can persist defaults with the `config` subcommand:

```sh
mo3ta-coverage config --base origin/main --mode smart --depth 2
```

This writes `.mo3ta-coverage.json` in the project root.

## How It Works

1. Reads CLI options and saved config from [index.js](index.js).
2. Finds changed source files from git in [src/cli.js](src/cli.js).
3. Maps source files to related test files in [src/fileUtils.js](src/fileUtils.js).
   `smart` mode combines naming conventions with a cached reverse-import index
   and walks it up to `--depth` edges.
4. Runs Jest in the selected mode from [src/cli.js](src/cli.js).
5. Parses `lcov.info` and reports uncovered changed lines.

## Development

```sh
npm install
npm test
```

## Security & dependencies

All dependencies in [`package.json`](package.json) are **pinned to exact
versions** (no `^` or `~`), so installs are reproducible and unaffected by
upstream releases. The `package-lock.json` is committed and CI installs with
`npm ci` against it.

### Vulnerability policy

- Transitive dependencies with known advisories are pinned to fixed versions
  through `overrides` in `package.json` when a compatible upstream release is
  not yet available (this keeps Jest 30 instead of downgrading for a
  transitive `glob`/`minimatch` advisory).
- `npm audit` must report **0 known vulnerabilities** before changes that
  touch dependencies are merged.

### Automated daily audit

The [`Dependency security audit` workflow](.github/workflows/dependency-audit.yml)
runs `npm audit` **daily** (plus on push, pull request, and manual dispatch):

- On vulnerabilities: opens (or refreshes) a single tracked issue —
  **`[Security] Vulnerable dependencies`** (label: `security`) — with the
  summary table, affected packages, advisory links, and fix steps.
- When the audit is clean again, it closes that issue automatically.
- The issue is managed by [`.github/scripts/audit-open-issue.mjs`](.github/scripts/audit-open-issue.mjs)
  via the `gh` CLI, so repeated runs never create duplicates.

## Pull requests

Security hardening (shell-injection-safe git/jest invocations) and dependency
pinning were introduced in [#12](https://github.com/MahmoudMabrok/mo3ta-coverage/pull/12).

## License

MIT
