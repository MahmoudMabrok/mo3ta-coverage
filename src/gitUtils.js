import { execSync } from 'child_process';
import { exit } from 'process';

export function verifyGitRepoExists() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  } catch (err) {
    console.error(`❌ Not a git repository. Please run this tool inside a git repo. ${err.message}`);
    exit(1);
  }
}

export function verifyBaseBranchExists(BASE_BRANCH) {
  try {
    execSync(`git rev-parse --verify ${BASE_BRANCH}`, { stdio: 'ignore' });
  } catch (err) {
    console.error(`❌ Base branch "${BASE_BRANCH}" does not exist or is invalid. try git fetch to update your local branches.`);
    exit(1);
  }
}
