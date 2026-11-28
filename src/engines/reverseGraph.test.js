import {
  buildReverseGraph,
  traverseReverseGraph,
  traverseReverseGraphWithPaths,
  reconstructPath,
  findRelatedTestsPerSource
} from './reverseGraph.js';

describe('buildReverseGraph', () => {
  it('returns an empty map for empty or missing input', () => {
    expect(buildReverseGraph([])).toEqual(new Map());
    expect(buildReverseGraph(null)).toEqual(new Map());
    expect(buildReverseGraph(undefined)).toEqual(new Map());
  });

  it('maps each dependency to its set of importers', () => {
    const graph = buildReverseGraph([
      { file: 'src/b.js', dependencies: ['src/a.js'] },
      { file: 'src/c.js', dependencies: ['src/a.js', 'src/b.js'] }
    ]);

    expect(Array.from(graph.get('src/a.js')).sort()).toEqual(['src/b.js', 'src/c.js']);
    expect(Array.from(graph.get('src/b.js'))).toEqual(['src/c.js']);
    expect(graph.has('src/c.js')).toBe(false);
  });

  it('ignores self-edges where a file depends on itself', () => {
    const graph = buildReverseGraph([
      { file: 'src/a.js', dependencies: ['src/a.js', 'src/b.js'] }
    ]);

    expect(graph.has('src/a.js')).toBe(false);
    expect(Array.from(graph.get('src/b.js'))).toEqual(['src/a.js']);
  });
});

describe('traverseReverseGraph', () => {
  // Graph: a <- b <- c <- d <- e
  const linearGraph = buildReverseGraph([
    { file: 'b.js', dependencies: ['a.js'] },
    { file: 'c.js', dependencies: ['b.js'] },
    { file: 'd.js', dependencies: ['c.js'] },
    { file: 'e.js', dependencies: ['d.js'] }
  ]);

  it('returns only start files at distance 0 when maxDepth is 0 or negative/NaN', () => {
    expect(traverseReverseGraph(linearGraph, ['a.js'], 0)).toEqual(new Map([['a.js', 0]]));
    expect(traverseReverseGraph(linearGraph, ['a.js'], -3)).toEqual(new Map([['a.js', 0]]));
    expect(traverseReverseGraph(linearGraph, ['a.js'], Number.NaN)).toEqual(new Map([['a.js', 0]]));
  });

  it('respects depth 1, 2, 3 and excludes nodes beyond maxDepth', () => {
    expect(traverseReverseGraph(linearGraph, ['a.js'], 1)).toEqual(new Map([
      ['a.js', 0],
      ['b.js', 1]
    ]));

    expect(traverseReverseGraph(linearGraph, ['a.js'], 2)).toEqual(new Map([
      ['a.js', 0],
      ['b.js', 1],
      ['c.js', 2]
    ]));

    expect(traverseReverseGraph(linearGraph, ['a.js'], 3)).toEqual(new Map([
      ['a.js', 0],
      ['b.js', 1],
      ['c.js', 2],
      ['d.js', 3]
    ]));
  });

  it('supports Infinity for unlimited traversal depth', () => {
    expect(traverseReverseGraph(linearGraph, ['a.js'], Infinity)).toEqual(new Map([
      ['a.js', 0],
      ['b.js', 1],
      ['c.js', 2],
      ['d.js', 3],
      ['e.js', 4]
    ]));
  });

  it('handles cycles (A -> B -> C -> A) and terminates with shortest distance', () => {
    const cyclicGraph = buildReverseGraph([
      { file: 'b.js', dependencies: ['a.js'] },
      { file: 'c.js', dependencies: ['b.js'] },
      { file: 'a.js', dependencies: ['c.js'] }
    ]);

    const distances = traverseReverseGraph(cyclicGraph, ['a.js'], Infinity);
    expect(distances).toEqual(new Map([
      ['a.js', 0],
      ['b.js', 1],
      ['c.js', 2]
    ]));
  });

  it('preserves shortest distance in a diamond graph', () => {
    // a <- b <- d (length 2) and a <- c <- e <- d (length 3)
    const diamondGraph = buildReverseGraph([
      { file: 'b.js', dependencies: ['a.js'] },
      { file: 'c.js', dependencies: ['a.js'] },
      { file: 'd.js', dependencies: ['b.js', 'e.js'] },
      { file: 'e.js', dependencies: ['c.js'] }
    ]);

    const distances = traverseReverseGraph(diamondGraph, ['a.js'], Infinity);
    expect(distances.get('d.js')).toBe(2);
    expect(distances.get('e.js')).toBe(2);
  });

  it('honors shouldExpand predicate by recording node distance without expanding through it', () => {
    // a <- a.test.js <- helper.test.js (and a <- mid.js <- mid.test.js)
    const graph = buildReverseGraph([
      { file: 'a.test.js', dependencies: ['a.js'] },
      { file: 'helper.test.js', dependencies: ['a.test.js'] },
      { file: 'mid.js', dependencies: ['a.js'] },
      { file: 'mid.test.js', dependencies: ['mid.js'] }
    ]);

    const stopAtTests = traverseReverseGraph(graph, ['a.js'], Infinity, {
      shouldExpand: node => !node.endsWith('.test.js')
    });
    expect(stopAtTests).toEqual(new Map([
      ['a.js', 0],
      ['a.test.js', 1],
      ['mid.js', 1],
      ['mid.test.js', 2]
    ]));
    expect(stopAtTests.has('helper.test.js')).toBe(false);

    const expandAll = traverseReverseGraph(graph, ['a.js'], Infinity);
    expect(expandAll.get('helper.test.js')).toBe(2);
  });

  it('always expands startFiles at depth 0 even if shouldExpand returns false for them', () => {
    const graph = buildReverseGraph([
      { file: 'other.test.js', dependencies: ['a.test.js'] }
    ]);

    const distances = traverseReverseGraph(graph, ['a.test.js'], 1, {
      shouldExpand: node => !node.endsWith('.test.js')
    });

    expect(distances).toEqual(new Map([
      ['a.test.js', 0],
      ['other.test.js', 1]
    ]));
  });
});

describe('traverseReverseGraphWithPaths and reconstructPath', () => {
  it('tracks predecessors and reconstructs shortest paths', () => {
    const graph = buildReverseGraph([
      { file: 'barrel.js', dependencies: ['util.js'] },
      { file: 'service.js', dependencies: ['barrel.js'] },
      { file: 'service.test.js', dependencies: ['service.js'] }
    ]);

    const { distances, predecessors } = traverseReverseGraphWithPaths(graph, ['util.js'], 3);

    expect(distances.get('service.test.js')).toBe(3);
    expect(reconstructPath(predecessors, 'util.js')).toEqual(['util.js']);
    expect(reconstructPath(predecessors, 'service.test.js')).toEqual([
      'util.js',
      'barrel.js',
      'service.js',
      'service.test.js'
    ]);
    expect(reconstructPath(predecessors, 'missing.js')).toEqual([]);
  });

  it('guards against unexpected cycles in predecessors map', () => {
    const cyclicPredecessors = new Map([
      ['a.js', 'b.js'],
      ['b.js', 'a.js']
    ]);

    expect(reconstructPath(cyclicPredecessors, 'b.js')).toEqual(['a.js', 'b.js']);
  });
});

describe('findRelatedTestsPerSource', () => {
  const isTestFile = file => /\.test\.js$/.test(file);

  it('computes independent per-source mappings, distances, and explain paths', () => {
    const graph = buildReverseGraph([
      { file: 'src/shared.js', dependencies: ['src/a.js'] },
      { file: 'src/a.test.js', dependencies: ['src/a.js'] },
      { file: 'src/shared.test.js', dependencies: ['src/shared.js'] },
      { file: 'src/b.test.js', dependencies: ['src/b.js', 'src/shared.js'] }
    ]);

    const result = findRelatedTestsPerSource(graph, ['src/a.js', 'src/b.js'], {
      maxDepth: 2,
      isTestFile,
      explain: true
    });

    expect(result.testsToRun).toEqual([
      'src/a.test.js',
      'src/b.test.js',
      'src/shared.test.js'
    ]);

    const forA = result.bySource.get('src/a.js');
    expect(forA.tests).toEqual(['src/a.test.js', 'src/b.test.js', 'src/shared.test.js']);
    expect(forA.distances).toEqual(new Map([
      ['src/a.test.js', 1],
      ['src/shared.test.js', 2],
      ['src/b.test.js', 2]
    ]));
    expect(forA.paths.get('src/shared.test.js')).toEqual([
      'src/a.js',
      'src/shared.js',
      'src/shared.test.js'
    ]);

    const forB = result.bySource.get('src/b.js');
    expect(forB.tests).toEqual(['src/b.test.js']);
    expect(forB.distances).toEqual(new Map([['src/b.test.js', 1]]));
    expect(forB.paths.get('src/b.test.js')).toEqual(['src/b.js', 'src/b.test.js']);
  });

  it('leaves paths map empty when explain is false', () => {
    const graph = buildReverseGraph([
      { file: 'src/a.test.js', dependencies: ['src/a.js'] }
    ]);

    const result = findRelatedTestsPerSource(graph, ['src/a.js'], {
      maxDepth: 2,
      isTestFile,
      explain: false
    });

    expect(result.bySource.get('src/a.js').paths.size).toBe(0);
  });

  it('includes a changed test file itself at distance 0', () => {
    const graph = buildReverseGraph([
      { file: 'src/other.test.js', dependencies: ['src/direct.test.js'] }
    ]);

    const result = findRelatedTestsPerSource(graph, ['src/direct.test.js'], {
      maxDepth: 1,
      isTestFile,
      explain: true
    });

    expect(result.testsToRun).toEqual(['src/direct.test.js', 'src/other.test.js']);
    const entry = result.bySource.get('src/direct.test.js');
    expect(entry.distances.get('src/direct.test.js')).toBe(0);
    expect(entry.distances.get('src/other.test.js')).toBe(1);
    expect(entry.paths.get('src/direct.test.js')).toEqual(['src/direct.test.js']);
  });
});
