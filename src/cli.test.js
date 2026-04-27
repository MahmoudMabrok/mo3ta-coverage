import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyChangedLineCoverage, parseLcov } from './cli.js';

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
  it('does not treat changed lines missing from LCOV as covered', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,1']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([11, 12, 13, 14], coverage);

    expect(result.coveredLines).toEqual([]);
    expect(result.uncoveredLines).toEqual([]);
    expect(result.missingLines).toEqual([11, 12, 13, 14]);
  });

  it('handles mixed covered, uncovered, and missing-from-LCOV lines', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,3', 'DA:11,0']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([10, 11, 12], coverage);

    expect(result.coveredLines).toEqual([10]);
    expect(result.uncoveredLines).toEqual([11]);
    expect(result.missingLines).toEqual([12]);
  });

  it('keeps existing behavior for normal covered and uncovered LCOV lines', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:20,5', 'DA:21,0']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([20, 21], coverage);

    expect(result.coveredLines).toEqual([20]);
    expect(result.uncoveredLines).toEqual([21]);
    expect(result.missingLines).toEqual([]);
  });
});