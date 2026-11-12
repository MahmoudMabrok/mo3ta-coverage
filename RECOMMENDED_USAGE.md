# Recommended Usage for Large Projects

## TL;DR

For projects with large suites or shared test infrastructure, use:

```bash
mo3ta-coverage --mode smart --base origin/main --limit 80
```

## Why `smart`

`smart` avoids Jest dependency traversal by running only test files that are themselves changed in the diff. It never expands to every test file related to a changed source file, which keeps the run predictable for large projects.

## Mode Comparison

| Mode | What Jest Receives | Traversal | Typical Outcome |
|------|--------------------|-----------|-----------------|
| `fast` | mapped test files | none | fastest run |
| `smart` | changed test files only | none | predictable changed-file check |
| `full` | mapped test files via `--findRelatedTests` | yes | can expand widely |

## Project Setup

### CLI

```bash
mo3ta-coverage --mode smart --base origin/main --limit 80
```

### Config File

```json
{
  "base": "origin/main",
  "mode": "smart"
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

## When To Use `full`

Use `full` only if you explicitly want Jest to discover more tests through dependency traversal and you accept that this may widen the run substantially.

## When To Use `fast`

Use `fast` when you want the quickest direct execution of mapped tests and do not want source files added to the Jest argument list.

## Summary

For large codebases, `smart` should be your default operational mode.
