# Recommended Usage for Large Projects

## TL;DR

For projects with large suites or shared test infrastructure, use:

```bash
mo3ta-coverage --mode smart --base origin/main --limit 80
```

## Why `smart`

`smart` avoids Jest dependency traversal by running only the related test files directly. It combines naming-convention matches with a depth-limited reverse-import walk: test files that directly import a changed file (`--depth 1`), or that import a module which imports it (`--depth 2`, the default). That catches differently named specs and barrel/re-export layers without pulling in the whole dependency graph, making it the most predictable mode for large projects.

## Mode Comparison

| Mode | What Jest Receives | Traversal | Typical Outcome |
|------|--------------------|-----------|-----------------|
| `fast` | naming-mapped test files (+ direct import fallback) | none | fastest run |
| `smart` | related test files (naming + reverse imports, depth ≤ 2) | bounded | best balance |
| `full` | changed source/test files via `--findRelatedTests` | unbounded | can expand widely |

## Tuning `smart` Depth

```bash
# Direct importers only
mo3ta-coverage --mode smart --depth 1

# Direct importers plus one intermediate module (default)
mo3ta-coverage --mode smart --depth 2
```

Use `--depth 1` when modules are tested directly. Keep `--depth 2` when the
codebase uses barrel `index.js` files or thin wrapper modules between a helper
and its spec.

## Project Setup

### CLI

```bash
mo3ta-coverage --mode smart --base origin/main --limit 80
```

### Config File

```json
{
  "base": "origin/main",
  "mode": "smart",
  "depth": 2
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

For large codebases, `smart` should be your default operational mode.
