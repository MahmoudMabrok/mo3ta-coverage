# mo3ta-coverage ![NPM Version](https://img.shields.io/npm/v/mo3ta-coverage)

mo3ta-coverage checks coverage for changed lines in a pull request. It finds changed source files, maps them to likely test files, runs Jest in a selected execution mode, and validates changed-line coverage against a threshold.

## Features

- Detects changed JS/TS files from git history and working tree
- Maps changed source files to nearby test files automatically
- Supports three execution modes: `fast`, `smart`, and `full`
- Parses `lcov.info` and reports uncovered changed lines
- Enforces a minimum coverage threshold for changed lines

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

## Modes

- `fast`: Direct execution of mapped test files only. No Jest dependency traversal.
- `smart`: Direct execution of changed source files plus mapped test files. No Jest dependency traversal.
- `full`: Runs mapped test files through `jest --findRelatedTests`.

## Recommended Mode

For most projects, especially large ones with shared helpers or deep import graphs, use:

```sh
mo3ta-coverage --mode smart --base origin/main --limit 80
```

Use `full` only when you intentionally want Jest to expand to related tests.

## Configuration

You can persist defaults with the `config` subcommand:

```sh
mo3ta-coverage config --base origin/main --mode smart
```

This writes `.mo3ta-coverage.json` in the project root.

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

## Additional Reading

- [OPTIMIZATION_GUIDE.md](OPTIMIZATION_GUIDE.md)
- [QUICK_REFERENCE.md](QUICK_REFERENCE.md)
- [RECOMMENDED_USAGE.md](RECOMMENDED_USAGE.md)
- [JEST_PR_HISTORY.md](JEST_PR_HISTORY.md)

## License

MIT
