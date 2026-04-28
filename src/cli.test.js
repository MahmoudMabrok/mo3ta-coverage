import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  classifyChangedLineCoverage,
  formatMissedLinesSummary,
  parseLcov,
  summarizeCoverageResult
} from './cli.js';

function writeLcovFixture(records) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-coverage-'));
  const sourceFile = path.join(tempDir, 'src/example.js');
  const lcovFile = path.join(tempDir, 'lcov.info');

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'const x = 1;\nconst y = 2;\n');
  fs.writeFileSync(
    lcovFile,
    [
      'TN:',
      `SF:${sourceFile}`,
      ...records,
      'end_of_record'
    ].join('\n')
  );

  return { sourceFile, lcovFile };
}

describe('parseLcov', () => {
  it('records both coverableLines and uncoveredLines', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,1', 'DA:11,0']);

    const result = parseLcov(lcovFile);

    expect(result[sourceFile].coverableLines.has(10)).toBe(true);
    expect(result[sourceFile].coverableLines.has(11)).toBe(true);
    expect(result[sourceFile].uncoveredLines.has(10)).toBe(false);
    expect(result[sourceFile].uncoveredLines.has(11)).toBe(true);
  });
});

describe('classifyChangedLineCoverage', () => {
  it('filters out changed lines not in LCOV (like imports)', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,1']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([11, 12, 13, 14], coverage);

    expect(result.coveredLines).toEqual([]);
    expect(result.uncoveredLines).toEqual([]);
  });

  it('ignores changed lines with no LCOV entry and classifies rest as covered or uncovered', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,3', 'DA:11,0']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([10, 11, 12, 13], coverage);

    expect(result.coveredLines).toEqual([10]);
    expect(result.uncoveredLines).toEqual([11]);
  });

  it('keeps existing behavior for normal covered and uncovered LCOV lines', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:20,5', 'DA:21,0']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([20, 21], coverage);

    expect(result.coveredLines).toEqual([20]);
    expect(result.uncoveredLines).toEqual([21]);
  });
});

describe('summarizeCoverageResult', () => {
  it('passes when overall coverage equals the configured limit', () => {
    const result = summarizeCoverageResult(5, 1, 80);

    expect(result.overallCoverage).toBe(80);
    expect(result.passed).toBe(true);
    expect(result.icon).toBe('✅');
  });

  it('fails when overall coverage is below the configured limit', () => {
    const result = summarizeCoverageResult(5, 2, 80);

    expect(result.overallCoverage).toBe(60);
    expect(result.passed).toBe(false);
    expect(result.icon).toBe('🚨');
  });
});

describe('formatMissedLinesSummary', () => {
  it('formats uncovered files and lines for the final summary', () => {
    const result = formatMissedLinesSummary([
      { filePath: 'src/a.js', lines: [10, 11] },
      { filePath: 'src/b.js', lines: [7] }
    ]);

    expect(result).toEqual([
      '',
      'Missed changed lines by file:',
      ` - ${path.resolve('src/a.js')}:10`,
      ` - ${path.resolve('src/a.js')}:11`,
      ` - ${path.resolve('src/b.js')}:7`
    ]);
  });

  it('returns no summary lines when no files have missed lines', () => {
    expect(formatMissedLinesSummary([])).toEqual([]);
  });
});