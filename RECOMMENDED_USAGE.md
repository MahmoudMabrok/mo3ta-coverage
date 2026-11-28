# Recommended Usage for Large Projects

## TL;DR

For projects with large suites or shared test infrastructure, use:

```bash
mo3ta-coverage --mode smart --base origin/main --limit 80
```

## Why `smart`

`smart` avoids Jest dependency traversal by running only the related test files directly. It combines naming-convention matches with a depth-limited reverse-import walk: test files that directly import a changed file (`--depth 1`), or that import a module which imports it (`--depth 2`, the default). That catches differently named specs and barrel/re-export layers without pulling in the whole dependency graph, making it the most predictable mode for large projects.

## Mode & Engine Comparison

| Mode / Engine | What Jest Receives | Traversal | Cold / Warm Discovery | Best For |
|---------------|--------------------|-----------|-----------------------|----------|
| `fast` | naming-mapped test files (+ direct import fallback) | none | fastest | small/predictable suites |
| `smart` + `native` (default) | related test files (naming + regex reverse imports, depth ≤ 2) | bounded | fast cold & warm | most JS/TS & monorepo projects |
| `smart` + `jest` (opt-in) | related test files (Jest HasteFS + DependencyResolver, depth ≤ 2) | bounded | slower cold HasteMap, fast warm cache | custom Jest resolvers, `moduleNameMapper`, `__mocks__`, RN extensions, multi-project & `.snap` |
| `full` | changed source/test files via `--findRelatedTests` | unbounded | Jest full graph | intentional full-graph expansion |

## Choosing an Engine in `smart` Mode (`native` vs `jest`)

### Stick with `--engine native` (default) when:
- Your project uses standard relative imports, `tsconfig.json` / `jsconfig.json` `paths` & `baseUrl`, or workspace `package.json` entrypoints.
- You want the fastest cold CI startup with zero Jest HasteMap overhead.

### Opt into `--engine jest` when:
- You rely on custom Jest `resolver` hooks or non-trivial `moduleNameMapper` rules that static `tsconfig` lookup cannot express.
- Your tests depend on manual `__mocks__` directories or React Native platform extensions (`.ios.js`, `.android.js`, `.native.js`).
- You run a multi-project Jest config (`projects`, `--selectProjects`, `--ignoreProjects`) and want discovery and `--runTestsByPath` execution scoped accurately to active projects.
- You change `.snap` snapshot files and want Jest's `SnapshotResolver` to map them back to their owning test files.

> **Important:** Keep a full-suite CI job (e.g. on `main` or merge queues) as a safety net. Bounded discovery in either engine cannot see purely dynamic runtime `require(expr)` calls, and deleted/renamed files that no longer exist on disk or in HasteFS are skipped.

## Tuning `smart` Depth & Engine Options

```bash
# Direct importers only
mo3ta-coverage --mode smart --depth 1

# Direct importers plus one intermediate module (default)
mo3ta-coverage --mode smart --depth 2

# Opt into Jest HasteFS discovery with 4 workers and dependency-chain explanations
mo3ta-coverage --mode smart --engine jest --depth 2 --discoveryWorkers 4 --explain

# Fall back to native discovery if Jest discovery fails in a broken environment
mo3ta-coverage --mode smart --engine jest --fallback native --base origin/main --limit 80
```

Use `--depth 1` when modules are tested directly. Keep `--depth 2` when the
codebase uses barrel `index.js` files or thin wrapper modules between a helper
and its spec.

## Project Setup

### CLI

```bash
# Default (native engine)
mo3ta-coverage --mode smart --base origin/main --limit 80

# Opt-in Jest engine with fallback and explain
mo3ta-coverage --mode smart --engine jest --fallback native --explain --base origin/main --limit 80
```

### Config File (`.mo3ta-coverage.json`)

```json
{
  "base": "origin/main",
  "mode": "smart",
  "depth": 2,
  "engine": "jest",
  "discoveryWorkers": 2,
  "fallback": "native"
}
```

### package.json

```json
{
  "scripts": {
    "test:coverage": "mo3ta-coverage --mode smart --limit 80"
  }
}
```

### GitHub Actions

```yaml
- name: Run coverage check
  run: npx mo3ta-coverage --mode smart --base origin/main --limit 80
```

## Listing Tests For Other Tools

Use `--dryRun true` when another tool needs the same test selection this
tool would execute. It prints the test files (one path per line) on stdout
and stops before Jest and the coverage check:

```bash
mo3ta-coverage --mode smart --base origin/main --dryRun true
```

## When To Use `full`

Use `full` only if you explicitly want Jest to discover more tests through dependency traversal and you accept that this may widen the run substantially.

## When To Use `fast`

Use `fast` when you want the quickest direct execution of mapped tests and do not want source files added to the Jest argument list.

## Summary

For large codebases, `smart` (`--engine native`) should be your default operational mode. Opt into `--engine jest` when you need Jest's own resolver, `moduleNameMapper`, manual `__mocks__`, React Native platform extensions, multi-project scoping, or `.snap` mapping, and always keep a full-suite CI run as a safety net.
