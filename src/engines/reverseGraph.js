/**
 * Reverse dependency graph construction and bounded BFS traversal utilities.
 * Used by both the native import graph engine and the Jest HasteFS engine.
 */

function normalizeMaxDepth(maxDepth = 2) {
  if (maxDepth === Infinity) {
    return Infinity;
  }
  const parsed = Number(maxDepth);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

/**
 * Builds a reverse dependency graph mapping each dependency path to the Set
 * of files that import/depend on it. Self-edges are skipped.
 *
 * @param {Iterable<{ file: string, dependencies?: Iterable<string> }>} modules
 * @returns {Map<string, Set<string>>}
 */
export function buildReverseGraph(modules) {
  const graph = new Map();
  if (!modules) {
    return graph;
  }

  for (const mod of modules) {
    if (!mod || !mod.file || !mod.dependencies) {
      continue;
    }
    const { file, dependencies } = mod;
    for (const dependency of dependencies) {
      if (!dependency || dependency === file) {
        continue;
      }
      let importers = graph.get(dependency);
      if (!importers) {
        importers = new Set();
        graph.set(dependency, importers);
      }
      importers.add(file);
    }
  }

  return graph;
}

/**
 * Traverses a reverse dependency graph starting from `startFiles` up to
 * `maxDepth` edges, tracking minimum distances and predecessors for path
 * reconstruction.
 *
 * Start files are recorded at distance 0 (with `null` predecessor) and are
 * always expanded when `maxDepth >= 1`. For nodes reached at `depth > 0`,
 * `options.shouldExpand(node)` controls whether traversal continues through
 * that node (its distance and predecessor are still recorded).
 *
 * @param {Map<string, Set<string>>} graph
 * @param {Iterable<string>} startFiles
 * @param {number} [maxDepth=2]
 * @param {{ shouldExpand?: (node: string) => boolean }} [options]
 * @returns {{ distances: Map<string, number>, predecessors: Map<string, string | null> }}
 */
export function traverseReverseGraphWithPaths(graph, startFiles, maxDepth = 2, options = {}) {
  const distances = new Map();
  const predecessors = new Map();
  const effectiveDepth = normalizeMaxDepth(maxDepth);
  const shouldExpand = typeof options?.shouldExpand === 'function'
    ? options.shouldExpand
    : () => true;

  let frontier = new Set();
  if (startFiles) {
    for (const file of startFiles) {
      if (!distances.has(file)) {
        distances.set(file, 0);
        predecessors.set(file, null);
        frontier.add(file);
      }
    }
  }

  if (!graph || effectiveDepth === 0 || frontier.size === 0) {
    return { distances, predecessors };
  }

  for (let depth = 1; depth <= effectiveDepth && frontier.size > 0; depth++) {
    const next = new Set();

    for (const node of frontier) {
      const importers = graph.get(node);
      if (!importers) {
        continue;
      }

      for (const importer of importers) {
        if (distances.has(importer)) {
          continue;
        }
        distances.set(importer, depth);
        predecessors.set(importer, node);

        if (shouldExpand(importer)) {
          next.add(importer);
        }
      }
    }

    frontier = next;
  }

  return { distances, predecessors };
}

/**
 * Traverses a reverse dependency graph starting from `startFiles` up to
 * `maxDepth` edges and returns a map of reached nodes to their minimum distance.
 *
 * @param {Map<string, Set<string>>} graph
 * @param {Iterable<string>} startFiles
 * @param {number} [maxDepth=2]
 * @param {{ shouldExpand?: (node: string) => boolean }} [options]
 * @returns {Map<string, number>}
 */
export function traverseReverseGraph(graph, startFiles, maxDepth = 2, options = {}) {
  return traverseReverseGraphWithPaths(graph, startFiles, maxDepth, options).distances;
}

/**
 * Reconstructs the path `[startNode, ..., target]` from a predecessors map
 * produced by `traverseReverseGraphWithPaths`. Returns `[]` if `target` was
 * not reached.
 *
 * @param {Map<string, string | null>} predecessors
 * @param {string} target
 * @returns {string[]}
 */
export function reconstructPath(predecessors, target) {
  if (!predecessors || !predecessors.has(target)) {
    return [];
  }

  const chain = [];
  const seen = new Set();
  let current = target;

  while (current !== null && current !== undefined) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    chain.push(current);

    if (!predecessors.has(current)) {
      break;
    }
    current = predecessors.get(current);
  }

  chain.reverse();
  return chain;
}

/**
 * Finds related test files independently for each source file in `sourceFiles`.
 *
 * @param {Map<string, Set<string>>} graph
 * @param {Iterable<string>} sourceFiles
 * @param {{
 *   maxDepth?: number,
 *   isTestFile: (node: string) => boolean,
 *   shouldExpand?: (node: string) => boolean,
 *   explain?: boolean
 * }} options
 * @returns {{
 *   testsToRun: string[],
 *   bySource: Map<string, { tests: string[], distances: Map<string, number>, paths: Map<string, string[]> }>
 * }}
 */
export function findRelatedTestsPerSource(graph, sourceFiles, {
  maxDepth = 2,
  isTestFile = () => false,
  shouldExpand,
  explain = false
} = {}) {
  const allTests = new Set();
  const bySource = new Map();

  for (const source of sourceFiles || []) {
    const { distances, predecessors } = traverseReverseGraphWithPaths(
      graph,
      [source],
      maxDepth,
      { shouldExpand }
    );

    const testDistances = new Map();
    const paths = new Map();

    for (const [node, distance] of distances) {
      if (!isTestFile(node)) {
        continue;
      }
      testDistances.set(node, distance);
      allTests.add(node);
      if (explain) {
        paths.set(node, reconstructPath(predecessors, node));
      }
    }

    const tests = Array.from(testDistances.keys()).sort();
    bySource.set(source, {
      tests,
      distances: testDistances,
      paths
    });
  }

  return {
    testsToRun: Array.from(allTests).sort(),
    bySource
  };
}
