#!/usr/bin/env node
/**
 * Dependency-audit issue manager.
 *
 * Runs after `npm audit --json` in CI. Given the audit JSON (first argument,
 * defaults to ./audit.json):
 *
 *   - Vulnerabilities found → open one tracked issue, "[Security] Vulnerable
 *     dependencies" (label: `security`), with the full audit detail — or
 *     refresh the existing issue with the new findings.
 *   - Clean audit → close the open issue if one exists, otherwise do nothing.
 *
 * Uses the `gh` CLI with the GITHUB_TOKEN that workflows expose automatically
 * when `permissions: issues: write` is set.
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

const ISSUE_TITLE = '[Security] Vulnerable dependencies';
const ISSUE_LABEL = 'security';

function gh(argv) {
  const output = execFileSync('gh', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  return output.toString();
}

function num(n) {
  return n > 0 ? String(n) : '–';
}

function renderAdvisoryLines(pkg) {
  const lines = [`### \`${pkg.name}\``, ''];
  lines.push(`- Severity: **${pkg.severity}**`);
  if (pkg.range) {
    lines.push(`- Affected versions: \`${pkg.range}\``);
  }
  lines.push(
    `- Direct dependency: ${pkg.isDirect ? 'yes' : 'no'}`,
    `- Fix available: ${pkg.fixAvailable ? 'yes' : 'no'}`
  );
  const advisories = (pkg.via ?? []).filter(v => typeof v === 'object' && v && (v.url || v.title));
  const viaPackages = (pkg.via ?? []).filter(v => typeof v === 'string');
  if (viaPackages.length > 0) {
    lines.push(`- Introduced via: ${viaPackages.map(p => `\`${p}\``).join(', ')}`);
  }
  advisories.forEach(a => {
    if (a.title) {
      lines.push(`- **${a.title}**`);
    }
    if (a.url) {
      lines.push(`  - ${a.url}`);
    }
  });
  return lines;
}

function buildBody(counts, vulns, runUrl) {
  const packages = Object.values(vulns ?? {}).sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity)
  );

  const lines = [
    'Vulnerable dependencies were found by the automated `npm audit` run.',
    '',
    '## Summary',
    '',
    '| Info | Low | Moderate | High | Critical |',
    '| ---: | ---: | ---: | ---: | ---: |',
    `| ${num(counts.info)} | ${num(counts.low)} | ${num(counts.moderate)} | ${num(counts.high)} | ${num(counts.critical)} |`,
    '',
    `- **Run:** [audit run](${runUrl})`,
    `- **Checked at:** ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    '',
    '## Vulnerable packages',
    '',
  ];

  if (packages.length === 0) {
    lines.push('_No vulnerable package rows in the audit output (format may have changed)._');
  } else {
    packages.forEach(pkg => lines.push(...renderAdvisoryLines(pkg), ''));
  }

  lines.push(
    '## How to fix',
    '',
    '```sh',
    'npm audit        # inspect the full report',
    'npm audit fix    # apply compatible fixes',
    '```',
    '',
    'Dependencies are pinned to exact versions in `package.json` (no `^`/`~`).',
    'Update them here in a PR once a fix is available. This issue is refreshed',
    'by the `Dependency security audit` workflow and closed automatically once',
    'the audit reports no known vulnerable dependencies.',
    '',
    '<!-- dependency-audit:managed -->'
  );

  return lines.join('\n');
}

function severityRank(severity) {
  return { critical: 4, high: 3, moderate: 2, low: 1, info: 0 }[severity] ?? 0;
}

/**
 * Create the tracking label on first use; `--force` makes it a no-op when
 * the label already exists. Failures (e.g. missing `labels: write`) are
 * swallowed — the label is cosmetic, not required.
 */
function ensureLabel() {
  try {
    gh(['label', 'create', ISSUE_LABEL, '--color', 'd93025', '--force']);
  } catch {
    console.log(`(skipped label creation for "${ISSUE_LABEL}")`);
  }
}

// ---------------------------------------------------------------------------

function main() {
  const auditPath = process.argv[2] || 'audit.json';
  let audit;
  try {
    audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  } catch (err) {
    console.error(`Could not read audit JSON from ${auditPath}: ${err.message}`);
    return; // The audit step already reported the failure.
  }

  const counts = audit.metadata?.vulnerabilities ?? {};
  const total = (counts.info ?? 0) + (counts.low ?? 0) + (counts.moderate ?? 0) + (counts.high ?? 0) + (counts.critical ?? 0);
  console.log(`npm audit summary: ${JSON.stringify(counts)} — ${total} vulnerable package(s)`);

  ensureLabel();

  const issueList = gh(['issue', 'list', '--state', 'open', '--search', `in:title "${ISSUE_TITLE}"`, '--json', 'number']);
  const existing = (JSON.parse(issueList || '[]')[0] ?? {}).number ?? null;

  if (total === 0) {
    if (existing) {
      console.log(`Audit is clean — closing issue #${existing}`);
      gh(['issue', 'close', String(existing)]);
    } else {
      console.log('✅ No known vulnerable dependencies — nothing to do.');
    }
    return;
  }

  const body = buildBody(counts, audit.vulnerabilities, process.env.RUN_URL);

  if (existing) {
    console.log(`Refreshing issue #${existing}`);
    gh(['issue', 'edit', String(existing), '--title', ISSUE_TITLE, '--body', body, '--add-label', ISSUE_LABEL]);
  } else {
    console.log('Opening new vulnerability issue');
    try {
      gh(['issue', 'create', '--title', ISSUE_TITLE, '--body', body, '--label', ISSUE_LABEL]);
    } catch {
      // Label missing/unusable (e.g. no permission to reference it) — the
      // issue matters more than the label, so retry without it.
      console.log(`Could not apply "${ISSUE_LABEL}" label — creating issue without it.`);
      gh(['issue', 'create', '--title', ISSUE_TITLE, '--body', body]);
    }
  }
}

main();
