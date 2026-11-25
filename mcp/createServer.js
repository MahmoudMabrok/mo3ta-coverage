import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  checkChangedLineCoverage,
  listChangedFiles,
  mapRelatedTests
} from '../src/api.js';

const rootField = z.string().optional().describe(
  'Path to the git checkout to inspect. Defaults to CLAUDE_PROJECT_DIR when Claude Code sets it, otherwise the MCP server process cwd.'
);
const baseField = z.string().optional().describe(
  'Git ref to compare against (branch, tag, or commit). Defaults to .mo3ta-coverage.json "base" when useConfig is true, otherwise origin/main.'
);
const filesField = z.union([z.array(z.string()), z.string()]).optional().describe(
  'Scan these repo-relative paths instead of git changed-file detection. A comma-separated string or an array. An empty list does not fall back to git.'
);
const filesFromField = z.string().optional().describe(
  'Newline-separated file list to scan, relative to root (for example the output of git diff --name-only).'
);
const modeField = z.string().optional().describe(
  'Test selection mode: fast (filename plus a direct import scan), smart (filename plus a reverse-import walk, default), or full (jest --findRelatedTests).'
);
const depthField = z.union([z.number(), z.string()]).optional().describe(
  'Smart-mode reverse-import depth, an integer from 1 to 10. 1 = tests that import the file. 2 (default) = also one intermediate module.'
);
const useConfigField = z.boolean().optional().describe(
  'Read base, mode, and depth defaults from .mo3ta-coverage.json in the repo. Default true. Explicit arguments override the file. Set false to ignore a broken config.'
);

const INSTRUCTIONS = [
  'mo3ta-coverage checks coverage of lines changed versus a base ref.',
  'Use list_changed_files to see changed JS/TS files, map_related_tests to see which tests would run, and check_changed_line_coverage to get the uncovered changed lines to write tests for.',
  'check_changed_line_coverage runs the repo\'s local Jest and writes coverage/ in that repo. Pass runTests: false to read an existing lcov file instead.',
  'A result with ok: false and uncovered lines is a coverage gap, not a crashed tool. Operational problems (not a git repo, bad base ref, Jest missing) come back as tool errors with a code and a hint.'
].join(' ');

function toolResult(data, { isError = false } = {}) {
  const payload = JSON.parse(JSON.stringify(data));
  const summary = payload.summary || payload.message || '';
  return {
    isError,
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(payload, null, 2)}` }],
    structuredContent: payload
  };
}

function errorResult(error) {
  const data = {
    ok: false,
    code: error.code || 'UNEXPECTED',
    message: error.message || String(error)
  };
  if (error.hint) data.hint = error.hint;
  if (error.jest) data.jest = error.jest;
  const summary = [data.message, data.hint].filter(Boolean).join('\n');
  return toolResult({ ...data, summary }, { isError: true });
}

function run(fn, args) {
  try {
    return toolResult(fn(args || {}));
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * MCP server that exposes mo3ta-coverage as tools. Does not connect a transport.
 * @param {{version?: string}} [options]
 */
export function createServer({ version = '0.0.0' } = {}) {
  const server = new McpServer({
    name: 'mo3ta-coverage',
    version
  }, {
    instructions: INSTRUCTIONS
  });

  server.registerTool(
    'list_changed_files',
    {
      title: 'List changed files',
      description: 'List JavaScript and TypeScript files changed versus a base ref (every author since the merge base, plus staged and unstaged edits). Pass files or filesFrom to scan an explicit list instead. Does not run tests.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        root: rootField,
        base: baseField,
        files: filesField,
        filesFrom: filesFromField,
        useConfig: useConfigField
      }
    },
    async args => run(listChangedFiles, args)
  );

  server.registerTool(
    'map_related_tests',
    {
      title: 'Map related tests',
      description: 'Map changed source files to the test files fast, smart, or full mode would run. smart (default) uses filenames plus a depth-limited reverse-import walk. full cannot list Jest\'s expanded set until tests actually run. Does not run Jest or read coverage.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        root: rootField,
        base: baseField,
        files: filesField,
        filesFrom: filesFromField,
        mode: modeField,
        depth: depthField,
        useConfig: useConfigField
      }
    },
    async args => run(mapRelatedTests, args)
  );

  server.registerTool(
    'check_changed_line_coverage',
    {
      title: 'Check changed-line coverage',
      description: 'Run the changed-line coverage check. By default runs the repo\'s local Jest (writes coverage/ in that repo) and returns per-file uncovered changed lines with source text so you can add tests. Set runTests false to grade an existing lcov file. ok false with uncovered lines means the threshold was missed. Timeout defaults to 5 minutes (timeoutMs).',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        root: rootField,
        base: baseField,
        files: filesField,
        filesFrom: filesFromField,
        mode: modeField,
        depth: depthField,
        limit: z.union([z.number(), z.string()]).optional().describe(
          'Minimum percent of changed, coverable lines that must be covered. Default 80. Range 0 to 100.'
        ),
        lcov: z.string().optional().describe(
          'Path to lcov.info, relative to root or absolute. Default coverage/lcov.info.'
        ),
        runTests: z.boolean().optional().describe(
          'Run Jest before reading lcov. Default true. Set false to grade an existing report without running tests.'
        ),
        showCovered: z.boolean().optional().describe(
          'Also return covered changed line numbers. Uncovered lines are always returned. Default false.'
        ),
        timeoutMs: z.union([z.number(), z.string()]).optional().describe(
          'Kill Jest after this many milliseconds. Default 300000 (5 minutes). Range 1000 to 1800000.'
        ),
        ciReport: z.string().optional().describe(
          'Also write the CLI markdown table to this path (relative to root). Omitted by default so the tool does not create a report file.'
        ),
        useConfig: useConfigField
      }
    },
    async args => run(checkChangedLineCoverage, args)
  );

  return server;
}
