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
const engineField = z.string().optional().describe(
  'Discovery engine for smart mode: native (default JS/TS import-graph scan) or jest (opt-in Jest HasteFS, DependencyResolver, and SearchSource discovery in an isolated worker). Only supported in smart mode. Reads "engine" from .mo3ta-coverage.json when not passed explicitly.'
);
const discoveryWorkersField = z.union([z.number(), z.string()]).optional().describe(
  'Number of parallel workers for Jest dependency discovery (integer 1 to 16, default 2). Reads "discoveryWorkers" from .mo3ta-coverage.json when not passed explicitly.'
);
const explainField = z.boolean().optional().describe(
  'Include discovery dependency paths and project matches in the result when engine is "jest". Default false.'
);
const fallbackField = z.string().optional().describe(
  'Fallback policy when engine "jest" fails discovery: error (default, fail with a coded error) or native (fall back to native import-graph discovery with a warning). Reads "fallback" from .mo3ta-coverage.json when not passed explicitly.'
);
const jestArgsField = z.union([z.array(z.string()), z.string()]).optional().describe(
  'Extra Jest CLI flags to pass through, e.g. ["--maxWorkers=4","--silent"] or "--maxWorkers=4,--silent". Appended to the tool\'s own Jest arguments.'
);
const filterField = z.string().optional().describe(
  'Regular expression matched against the final list of selected spec files; only matching test paths run. Example: "src/__tests__/login". Reads "filter" from .mo3ta-coverage.json when not passed explicitly.'
);
const useConfigField = z.boolean().optional().describe(
  'Read base, mode, depth, engine, discoveryWorkers, fallback, jest, and filter defaults from .mo3ta-coverage.json in the repo. Default true. Explicit arguments override the file. Set false to ignore a broken config.'
);

const INSTRUCTIONS = [
  'mo3ta-coverage checks coverage of lines changed versus a base ref.',
  'Use list_changed_files to see changed JS/TS files, map_related_tests to see which tests would run, and check_changed_line_coverage to get the uncovered changed lines to write tests for.',
  'In smart mode, engine defaults to "native" and can be set to "jest" (with optional discoveryWorkers, explain, and fallback) to resolve tests via Jest\'s own HasteFS and DependencyResolver.',
  'check_changed_line_coverage runs the repo\'s local Jest and writes coverage/ in that repo. Pass runTests: false to read an existing lcov file instead.',
  'Pass a filter (a regex) to map_related_tests or check_changed_line_coverage to narrow the final list of selected spec files to the matching paths. The result includes allTestsToRun (before the filter) and testsToRun (after) so you can validate the match.',
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
      description: 'Map changed source files to the test files fast, smart, or full mode would run. smart (default) uses filenames plus a depth-limited reverse-import walk (engine "native", default) or Jest\'s own HasteFS/DependencyResolver (engine "jest", supporting discoveryWorkers, explain, and fallback). full cannot list Jest\'s expanded set until tests actually run. Pass filter (a regex) to narrow the selected spec files to matching paths. Does not run Jest tests or read coverage.',
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
        engine: engineField,
        discoveryWorkers: discoveryWorkersField,
        explain: explainField,
        fallback: fallbackField,
        filter: filterField,
        useConfig: useConfigField
      }
    },
    async args => run(mapRelatedTests, args)
  );

  server.registerTool(
    'check_changed_line_coverage',
    {
      title: 'Check changed-line coverage',
      description: 'Run the changed-line coverage check. By default runs the repo\'s local Jest (writes coverage/ in that repo) and returns per-file uncovered changed lines with source text so you can add tests. In smart mode, pass engine: "jest" (with optional discoveryWorkers, explain, and fallback) to discover related tests via Jest\'s own module graph. Set runTests false to grade an existing lcov file. ok false with uncovered lines means the threshold was missed. Timeout defaults to 5 minutes (timeoutMs).',
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
        engine: engineField,
        discoveryWorkers: discoveryWorkersField,
        explain: explainField,
        fallback: fallbackField,
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
        jest: jestArgsField,
        filter: filterField,
        useConfig: useConfigField
      }
    },
    async args => run(checkChangedLineCoverage, args)
  );

  return server;
}
