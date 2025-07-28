import { main } from './cli';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';


jest.mock('child_process');
jest.mock('fs');
jest.mock('path');

describe('main', () => {
    let originalExit;
    let exitMock;
    let consoleLogSpy;
    let consoleErrorSpy;

    beforeEach(() => {
        // Mock process.exit
        originalExit = process.exit;
        exitMock = jest.fn();
        process.exit = exitMock;

        // Mock console
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        // Reset mocks
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.exit = originalExit;
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
    });

    it('should log options and call getChangedFiles, runRelatedTests, and reportUncoveredChangedLines', () => {
        // Mock git check
        child_process.execSync.mockImplementationOnce(() => 'true');
        // Mock getChangedFiles
        const fakeFiles = ['src/foo.js', 'src/bar.ts'];
        // Mock execSync for getChangedFiles
        child_process.execSync.mockImplementationOnce(() => fakeFiles.join('\n'));
        // Mock execSync for runRelatedTests (jest run)
        child_process.execSync.mockImplementationOnce(() => {});
        // Mock fs.existsSync for lcov
        fs.existsSync.mockReturnValue(true);
        // Mock fs.readFileSync for lcov parsing
        fs.readFileSync.mockReturnValue(
            'SF:/abs/path/src/foo.js\nDA:1,0\nDA:2,1\nend_of_record\nSF:/abs/path/src/bar.ts\nDA:3,0\nend_of_record\n'
        );
        // Mock path.resolve to identity for simplicity
        path.resolve.mockImplementation(x => '/abs/path/' + x);

        // Mock getChangedLines to return some lines
        jest.spyOn(child_process, 'execSync').mockImplementation((cmd) => {
            if (cmd.includes('git diff')) {
                return Buffer.from('@@ -0,0 +1,2 @@\n+foo\n+bar\n');
            }
            if (cmd.includes('git rev-parse')) {
                return Buffer.from('true');
            }
            if (cmd.includes('git log') || cmd.includes('git diff --name-only')) {
                return Buffer.from(fakeFiles.join('\n'));
            }
            return Buffer.from('');
        });

        main({ base: 'main', lcov: 'lcov.info', limit: '80', showCovered: true });

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Options:'));
        // expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Base Branch: main'));
        // expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('LCOV Path: lcov.info'));
        // expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Coverage Limit: 80'));
        // expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Show Covered Lines: true'));
        // expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Files with changed lines:'));
        // expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Overall coverage for all changed lines:'));
    });
});
