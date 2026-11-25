import { execFileSync } from 'child_process';
import { exit } from 'process';

/**
 * Checks that `cwd` is inside a git work tree.
 * Returns a result instead of exiting so callers (the CLI and the MCP server)
 * can decide how to surface the failure.
 * @param {string} [cwd]
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkGitRepository(cwd = process.cwd()) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore', cwd });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: `Not a git repository. Please run this tool inside a git repo. ${err.message}`
    };
  }
}

export function verifyGitRepoExists(cwd = process.cwd()) {
  const result = checkGitRepository(cwd);
  if (!result.ok) {
    console.error(`❌ ${result.message}`);
    exit(1);
  }
}

/**
 * Checks that `baseRef` resolves to a commit. The ref is passed as one
 * argument (never through a shell) and git `--verify` rejects option-like
 * values such as `--upload-pack=...`.
 * @param {string} baseRef
 * @param {string} [cwd]
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkBaseRef(baseRef, cwd = process.cwd()) {
  const message = `Base branch "${baseRef}" does not exist or is invalid. try git fetch to update your local branches.`;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], { stdio: 'ignore', cwd });
    return { ok: true };
  } catch {
    return { ok: false, message };
  }
}

export function verifyBaseBranchExists(BASE_BRANCH, cwd = process.cwd()) {
  const result = checkBaseRef(BASE_BRANCH, cwd);
  if (!result.ok) {
    console.error(`❌ ${result.message}`);
    exit(1);
  }
}
