# mo3ta-coverage ![NPM Version](https://img.shields.io/npm/v/mo3ta-coverage)

![mo3ta-coverage modes and features](docs/poster.png)

mo3ta-coverage checks coverage for changed lines in a pull request. It finds changed source files, maps them to likely test files, runs Jest in a selected execution mode, and validates changed-line coverage against a threshold.

Project site: https://mo3ta.top/mo3ta-coverage/

## Demo

https://github.com/user-attachments/assets/1139ca7a-69e6-4b41-ad24-ff20e083c4e0

A quick walkthrough of changed-file detection, related-test selection, and changed-line coverage.

## Features

- Detects changed JS/TS files from git history and working tree, for all authors
- Accepts an explicit file list (`--files` / `--filesFrom`) to control what gets scanned
- Maps changed source files to related test files, even when names differ
- Supports three execution modes: `fast`, `smart`, and `full`
- Walks reverse imports in `smart` mode to a configurable depth (default `2`) with either the zero-dependency `native` engine (default) or the opt-in `jest` engine (Jest 29/30 HasteFS + DependencyResolver)
- Explains why each test was selected (`--explain`) and supports configurable fallback (`--fallback native`) when `--engine jest` cannot initialize
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
Input forwarding for `--engine`, `--discoveryWorkers`, `--explain`, and
`--fallback` is tracked separately in the
[`mo3ta-coverage-action`](https://github.com/MahmoudMabrok/mo3ta-coverage-action)
repository.

## Installation

```sh
npm install -g mo3ta-coverage
```

### Install from GitHub

Prefer the latest commit over the published npm release? Install directly from
this repository — no publish step, no clone needed:

```sh
# Global install from the default branch
npm install -g github:MahmoudMabrok/mo3ta-coverage

# One-off, without installing at all
npx github:MahmoudMabrok/mo3ta-coverage --mode smart --base origin/main --limit 80
```

Pin a release tag or a specific commit for reproducible installs:

```sh
npm install -g github:MahmoudMabrok/mo3ta-coverage#v1.1.0
npm install -g github:MahmoudMabrok/mo3ta-coverage#<commit-sha>
```

To build and run from a local checkout instead:

```sh
git clone https://github.com/MahmoudMabrok/mo3ta-coverage.git
cd mo3ta-coverage
npm install
npm link            # exposes the mo3ta-coverage binary globally
```

## Usage

```sh
mo3ta-coverage --mode smart --base origin/main --limit 80
```

## Recipes

Two common ways to use the CLI straight from GitHub — no global install.

### 1. Get the selected test files, then run Jest yourself

`--dryRun true` stops after test discovery and writes **only** the selected
test paths to stdout (one per line), so you can review them or hand them to
Jest directly — no coverage check, no extra runner:

```sh
# 1. Discover the tests that cover the changed files
npx github:MahmoudMabrok/mo3ta-coverage \
  --dryRun true \
  --mode smart \
  --base origin/main > selected-tests.txt

# 2. Run exactly those files with Jest
npx jest $(cat selected-tests.txt)
```

Or pipe the list straight into Jest:

```sh
npx github:MahmoudMabrok/mo3ta-coverage --dryRun true --base origin/main \
  | xargs npx jest
```

Diagnostics go to stderr, so the file/pipe contains paths only. See
[Dry Run](#dry-run-list-test-files-for-other-tools) for details.

### 2. Run the coverage check in smart mode

Leave `--dryRun` off and the CLI does the whole job: select the tests, run
Jest, parse `coverage/lcov.info`, and fail when changed-line coverage is below
`--limit`:

```sh
npx github:MahmoudMabrok/mo3ta-coverage \
  --mode smart \
  --base origin/main \
  --limit 80
```

`smart` follows reverse imports up to `--depth` (default `2`), which catches
specs that reach the changed file through barrel files. See
[Modes](#modes) for `fast`, `smart`, and `full`, and `--engine` for `native` vs `jest`.

### 3. Opt into the Jest discovery engine with `--explain` and `--fallback`

For repos using custom Jest resolvers, `moduleNameMapper`, manual `__mocks__`,
React Native platform extensions, multi-project configs, or `.snap` snapshot
mapping, opt into `--engine jest` in `smart` mode:

```sh
mo3ta-coverage \
  --mode smart \
  --engine jest \
  --discoveryWorkers 4 \
  --explain \
  --fallback native \
  --base origin/main \
  --limit 80
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
| `--engine <engine>` | Discovery engine for `smart` mode: `native` (default) or `jest` (opt-in) | `native` |
| `--discoveryWorkers <number>` | Worker count for Jest HasteMap discovery (`1`–`16`, used by `--engine jest`) | `2` |
| `--explain [bool]` | Print dependency chain explanations from changed files to selected tests (`smart` mode) | `false` |
| `--fallback <policy>` | Fallback policy when `--engine jest` fails: `error` or `native` | `error` |
| `--files <files...>` | Scan only these files instead of auto-detecting changed files (space- or comma-separated) | – |
| `--filesFrom <path>` | Read the file list to scan from a newline-separated file | – |
| `--jest <value>` | Extra Jest CLI flag passed through to the run, e.g. `--maxWorkers=2`. Repeatable or comma-separated | – |
| `--filter <regex>` | Regex matched against the final list of selected spec files; only matching test files run. The full and filtered lists are both printed for validation | – |
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

## Passing Extra Jest Flags

Use `--jest` to forward any Jest CLI flag to the underlying Jest run, for
example to control parallelism or silence output. Pass it once per flag, or
comma-separate several flags in one value:

```sh
# Limit Jest to 2 workers and run silently
mo3ta-coverage --base origin/main --jest --maxWorkers=2 --jest --silent

# Same thing, comma-separated
mo3ta-coverage --base origin/main --jest "--maxWorkers=2,--silent"

# A single flag that takes a value
mo3ta-coverage --base origin/main --jest --maxWorkers=50%
```

The flags are appended to the arguments mo3ta-coverage already passes
(`--coverage`, `--passWithNoTests`, and the selected test files), so they are
handled by Jest's own argument parser. Use them for things like `--maxWorkers`,
`--silent`, `--ci`, `--bail`, `--testTimeout`, or `--coverageDirectory`.

Jest flags that take a value work best in the `=` form (`--maxWorkers=2`). If a
flag's value is normally separated by a space, give each token its own `--jest`:

```sh
# Equivalent to: jest --maxWorkers 2
mo3ta-coverage --base origin/main --jest --maxWorkers --jest 2
```

To make flags the default for a repo, save them with the `config` subcommand:

```sh
mo3ta-coverage config --jest --maxWorkers=2 --jest --silent
# written to .mo3ta-coverage.json as "jest": ["--maxWorkers=2", "--silent"]
```

A `--jest` value on the command line overrides the saved list.

## Filtering Spec Files

Pass `--filter` a regular expression. After the mode has selected the test
files that would run, only the ones that **match** the regex are executed
(everything else is skipped). The regex is matched against the full
repo-relative spec path, so it can narrow by directory, project, or name:

```sh
# Only run specs under the login feature folder
mo3ta-coverage --base origin/main --filter "src/__tests__/login"

# Only run specs whose name contains "auth"
mo3ta-coverage --base origin/main --filter "auth"

# Combined with an explicit file list and a dry run to preview
mo3ta-coverage --files src/a.js,src/b.ts --base main --dryRun true --filter "b"
```

For validation, the run logs both lists:

```text
🔎 Filter regex: /src\/__tests__\/login/
   All test files before filter (5):
     - src/__tests__/login.spec.js
     - src/checkout/checkout.spec.js
     ...
   Test files after filter (1):
     - src/__tests__/login.spec.js
```

If the filter matches nothing, no tests are run and the tool exits 0 with
that log block, so you can see the candidate list and adjust the pattern.

In `full` mode the filter is also forwarded to Jest as
`--testPathPatterns`, since Jest discovers the related specs itself. If you
already set a Jest path pattern via `--jest --testPathPatterns=...`, your own
pattern wins.

To make the filter the default for a repo, save it with the `config`
subcommand:

```sh
mo3ta-coverage config --filter "src/__tests__/login"
# written to .mo3ta-coverage.json as "filter": "src/__tests__/login"
```

A `--filter` value on the command line overrides the saved one.

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

## Modes & Engines

- `fast`: Naming-convention matches only, plus a direct import-scan fallback. No dependency traversal.
- `smart` (default): Naming-convention matches plus a reverse-import walk from each changed file, limited by `--depth` (default `2`). Supports two engines via `--engine`:
  - `native` (default): Uses `mo3ta-coverage`'s built-in, zero-dependency filesystem scan and regex import resolver.
  - `jest` (opt-in): Runs Jest's own HasteFS, `DependencyResolver`, `SearchSource`, and `SnapshotResolver` inside an isolated worker subprocess, then traverses the reverse graph up to `--depth`.
- `full`: Passes the changed source and test files to `jest --findRelatedTests`, letting Jest traverse without a depth limit.

| Mode + Engine | Discovery Mechanism | Traversal | Cold / Warm Speed | Jest-Specific Features | Best For |
| --- | --- | --- | --- | --- | --- |
| `fast` | Naming conventions + direct import scan | None | Fastest | None | Small suites or direct 1:1 spec layouts |
| `smart` + `native` (default) | Naming + `tsconfig`/`jsconfig` + workspace `package.json` + regex import graph | Bounded (`--depth`) | Very fast cold & warm | None | Most JS/TS repos and monorepos |
| `smart` + `jest` (opt-in) | Project-local Jest 29/30 HasteMap + `DependencyResolver` | Bounded (`--depth`) | Slower cold HasteMap, fast warm cache | Custom `resolver`, `moduleNameMapper`, `__mocks__`, RN extensions, `projects`, `.snap` | Repos relying on Jest-specific resolution or multi-project configs |
| `full` | `jest --findRelatedTests` | Unbounded | Slower (full Jest graph) | Full Jest resolution | Intentional full-graph expansion |

### Depth in `smart` mode

One depth step is one import edge:

- `--depth 1`: test files that import the changed file directly.
- `--depth 2` (default): also test files that import a module which imports the changed file.
- `--depth 3`: recommended for monorepos where cross-package imports go through a package barrel (`index.ts`) and an intermediate consumer module (`changed.ts` → `pkg/index.ts` → `app/service.ts` → `app/service.test.ts`).

The `native` engine resolves relative imports, `tsconfig.json` / `tsconfig.base.json` / `jsconfig.json` `paths` & `baseUrl` (including per-package `extends`), and workspace `package.json` names (`exports`, `source`, `module`, `main`).

Depth `2` is usually the sweet spot for single-package projects: it catches barrel/re-export and thin wrapper layers without pulling in the whole dependency graph.

### Opt-in Jest engine (`--engine jest`)

When `--mode smart --engine jest` is enabled:

- **Jest compatibility (29 and 30)**: `mo3ta-coverage` resolves Jest directly from the target repository's `node_modules` (supporting npm, yarn, and pnpm layouts) and refuses to fall back to `mo3ta-coverage`'s own Jest installation.
- **Multi-project support**: Discovers across Jest `projects`, honors `--selectProjects` and `--ignoreProjects` passed via `--jest`, and automatically passes `--selectProjects` for `--runTestsByPath` execution when multiple named projects exist and only a subset matched.
- **Snapshot mapping**: Changed `.snap` files are mapped back to their owning test files through Jest's `SnapshotResolver`.
- **Dependency explanations (`--explain`)**: Prints the shortest dependency chain from each changed source file to each selected test file (and project name when multi-project).
- **Graceful fallback (`--fallback`)**: Defaults to `error` so configuration or Jest errors fail fast; pass `--fallback native` to fall back to the `native` engine when `--engine jest` cannot initialize.
- **Performance characteristics**: Unlike `native`, a cold `--engine jest` run builds Jest's HasteMap and resolves dependencies across all project files (`configMs`, `hasteMapMs`, `resolveMs`, `graphMs`, `bfsMs`). Subsequent runs with a warm Jest cache are substantially faster while still avoiding the unbounded expansion of `--mode full`.
- **Known limitations**: Static dependency graphs in both engines cannot detect purely dynamic/computed runtime imports (`require(variable)`), and deleted or renamed files that no longer exist on disk/HasteFS are skipped with a warning. Always keep a full-suite CI run (e.g. on `main`) as a safety net.

## Recommended Mode

For most projects, especially large ones with shared helpers or deep import graphs, use:

```sh
mo3ta-coverage --mode smart --base origin/main --limit 80
```

Opt into `--engine jest` if your suite relies on Jest custom resolvers, `moduleNameMapper`, manual `__mocks__`, React Native platform extensions, multi-project configs, or snapshot mapping. Use `full` only when you intentionally want Jest to expand to related tests without a depth bound.

## Configuration

You can persist defaults with the `config` subcommand:

```sh
mo3ta-coverage config --base origin/main --mode smart --depth 2
# Or persist Jest engine defaults:
mo3ta-coverage config --engine jest --discoveryWorkers 4 --fallback native
```

This writes `.mo3ta-coverage.json` in the project root. The `base`, `mode`,
`depth`, `engine`, `discoveryWorkers`, `fallback`, `jest` (extra Jest flags),
and `filter` (spec filter regex) defaults are supported. For example,
`mo3ta-coverage config --jest --maxWorkers=2` saves a default Jest worker cap,
and `mo3ta-coverage config --filter "src/__tests__/login"` saves a default spec
filter.

## MCP server

`mo3ta-coverage` also ships an [MCP](https://modelcontextprotocol.io) server so an agent working in a local checkout can list the changed files, see which tests would run, and read the uncovered changed lines it should write tests for. The server calls the same functions as the CLI. It does not reimplement git diffs, test mapping, or lcov parsing.

The server is a second bin in this package, `mo3ta-coverage-mcp`, speaking MCP over stdio. It lives here rather than in a separate package so one publish ships it, and so it imports this repo's source directly. The CLI flags, stdout, and exit codes are unchanged; the [GitHub Action](https://github.com/MahmoudMabrok/mo3ta-coverage-action) keeps running `node index.js`.

The server requires Node.js 18 or newer. Each tool takes `root` (the checkout to inspect). When `root` is omitted, Claude Code's `CLAUDE_PROJECT_DIR` is used if it is set, otherwise the server process cwd. `useConfig` defaults to true: `base`, `mode`, `depth`, `engine`, `discoveryWorkers`, `fallback`, `jest`, and `filter` are read from `.mo3ta-coverage.json` when present, and explicit arguments override the file.

| Tool | Purpose |
| --- | --- |
| `list_changed_files` | List JS/TS files changed versus a base ref (or an explicit list). |
| `map_related_tests` | Map those files to the tests `fast`, `smart` (`native` or `jest`), or `full` mode would run. |
| `check_changed_line_coverage` | Run the changed-line coverage check and return uncovered lines with source text. |

`check_changed_line_coverage` runs the repo's local Jest and writes `coverage/` there, same as the CLI. Jest is killed after `timeoutMs` (default 5 minutes) and only a tail of its output is returned. Pass `runTests: false` to grade an existing `lcov.info` without running tests. Both `map_related_tests` and `check_changed_line_coverage` also accept `engine` (`"native"` or `"jest"`), `discoveryWorkers` (`1`–`16`), `explain` (`true`/`false`), and `fallback` (`"error"` or `"native"`). Pass `jest` (an array of flags or a comma-separated string, e.g. `["--maxWorkers=4"]`) to forward extra Jest CLI flags, and `filter` (a regex) to narrow the final list of selected spec files. A missed threshold comes back as data (`ok: false` plus the uncovered lines), not a crashed tool. A missing git repo, a bad base ref, a missing Jest install, or a timeout comes back as a tool error with a `code` and a hint.

When a `filter` is used, results include `allTestsToRun` (the selected specs before the filter) and `testsToRun` (what matched), so an agent can validate that the regex kept what it expected.

`full` mode still delegates discovery to `jest --findRelatedTests`. `map_related_tests` can only list the changed test files until a check actually runs Jest, matching `--dryRun`.

### Run it

From a checkout, after `npm install`:

```sh
node mcp/server.js
# or
npx --package . -- mo3ta-coverage-mcp
```

Once this package is published, any project can start it without cloning the repo:

```sh
npx -y --package mo3ta-coverage mo3ta-coverage-mcp
```

The bin name and the package name differ, so `npx` needs `--package mo3ta-coverage` to install this package and then run the `mo3ta-coverage-mcp` binary.

### Claude Desktop

Add this to `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "mo3ta-coverage": {
      "command": "npx",
      "args": ["-y", "--package", "mo3ta-coverage", "mo3ta-coverage-mcp"]
    }
  }
}
```

### Cursor

Add this to `.cursor/mcp.json` in the project, or to Cursor's user MCP config:

```json
{
  "mcpServers": {
    "mo3ta-coverage": {
      "command": "npx",
      "args": ["-y", "--package", "mo3ta-coverage", "mo3ta-coverage-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add mo3ta-coverage -- npx -y --package mo3ta-coverage mo3ta-coverage-mcp
```

From a local checkout of this repo, point the command at the script instead:

```sh
claude mcp add mo3ta-coverage -- node /absolute/path/to/mo3ta-coverage/mcp/server.js
```

## How It Works

1. Reads CLI options and saved config from [index.js](index.js).
2. Finds changed source files from git in [src/cli.js](src/cli.js).
3. Maps source files to related test files via [src/engines/nativeEngine.js](src/engines/nativeEngine.js) and [src/fileUtils.js](src/fileUtils.js) (default), or [src/engines/jestEngine.js](src/engines/jestEngine.js) when `--engine jest` is selected.
   `smart` mode combines naming conventions with a reverse-import index
   and walks it up to `--depth` edges.
4. Runs Jest in the selected mode from [src/cli.js](src/cli.js).
5. Parses `lcov.info` and reports uncovered changed lines.

## Development

```sh
npm install
npm test     # Jest, then the MCP server tests (node --test)
node mcp/server.js
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
