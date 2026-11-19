import { execFileSync } from 'child_process';
import { exit } from 'process';

export function verifyGitRepoExists() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch (err) {
    console.error(`❌ Not a git repository. Please run this tool inside a git repo. ${err.message}`);
    exit(1);
  }
}

export function verifyBaseBranchExists(BASE_BRANCH) {
  try {
    // Accept any valid git ref (branch, tag, or revision like origin/main, HEAD~1).
    // Git is invoked with an argument array (never through a shell) and the value
    // is checked with --verify, so a hostile value such as `--upload-pack=cmd`
    // or `a; rm -rf ~` is rejected by git as an invalid ref instead of running.
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${BASE_BRANCH}^{commit}`], { stdio: 'ignore' });
  } catch (err) {
    console.error(`❌ Base branch "${BASE_BRANCH}" does not exist or is invalid. try git fetch to update your local branches.`);
    exit(1);
  }
}
