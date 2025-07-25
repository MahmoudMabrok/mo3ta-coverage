import { execSync } from 'child_process';

describe('CLI functionality', () => {

    test('should handle invalid commandnnn', () => {
        expect(() => {
            execSync('node src/cli.js invalidCommand');
        }).toThrow();
    });
});