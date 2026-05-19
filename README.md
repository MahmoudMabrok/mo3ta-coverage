# mo3ta-coverage ![NPM Version](https://img.shields.io/npm/v/mo3ta-coverage)

mo3ta-coverage checks coverage for changed lines in a pull request. It finds changed source files, maps them to likely test files, runs Jest in a selected execution mode, and validates changed-line coverage against a threshold.

## Features

- Detects changed JS/TS files from all commits in the current branch, uncommitted changes, and staged files
- Maps changed source files to nearby test files automatically
- Supports three execution modes: `fast`, `smart`, and `full`
- Smart mode includes reverse dependency analysis with configurable depth
- Parses `lcov.info` and reports uncovered changed lines
- Enforces a minimum coverage threshold for changed lines
- Helpful error messages when invalid options are provided

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
| `-v, --version` | Output the current version | - |
| `--base <branch>` | Base branch to compare against | `origin/main` |
| `--lcov <path>` | Path to `lcov.info` | `coverage/lcov.info` |
| `--limit <percent>` | Minimum changed-line coverage percentage | `80` |
| `--showCovered <bool>` | Show covered changed lines in output | `false` |
| `--mode <mode>` | Execution mode: `fast`, `smart`, or `full` (required) | `smart` |
| `--maxDepth <number>` | Maximum reverse dependency depth for smart mode | `3` |

## Modes

- **`fast`**: Direct execution of mapped test files only. No Jest dependency traversal. Fastest option.
- **`smart`**: Direct execution of changed source files plus mapped test files, with reverse dependency analysis. Includes tests for files that import your changes up to `--maxDepth` levels. Recommended for most projects.
- **`full`**: Runs mapped test files through `jest --findRelatedTests`. Let Jest expand to related tests. Use with caution in large projects.

If an invalid mode is provided, the tool will display available options with descriptions.

## Recommended Mode

For most projects, especially large ones with shared helpers or deep import graphs, use:

```sh
mo3ta-coverage --mode smart --base origin/main --limit 80
```

Use `full` only when you intentionally want Jest to expand to related tests.

## Configuration

You can persist defaults with the `config` subcommand:

```sh
mo3ta-coverage config --base origin/main --mode smart --maxDepth 3
```

This writes `.mo3ta-coverage.json` in the project root.

## Changed Files Detection

The tool detects changed files by comparing against the specified base branch:
- All committed files in the current branch (from merge-base to HEAD)
- Uncommitted changes in the working tree
- Staged changes (files added with `git add`)

This means coverage is checked for all changes in your branch, not just your authored commits.

## How It Works

1. Reads CLI options and saved config from [index.js](index.js).
2. Finds changed source files from git in [src/cli.js](src/cli.js).
3. Maps source files to nearby test files in [src/fileUtils.js](src/fileUtils.js).
4. Runs Jest in the selected mode from [src/cli.js](src/cli.js).
5. Parses `lcov.info` and reports uncovered changed lines.

## Development

```sh
npm install
npm test
```

## License

MIT
