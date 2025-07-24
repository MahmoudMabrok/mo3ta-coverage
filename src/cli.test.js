import { execSync } from 'child_process';

describe('CLI functionality', () => {

    test('should handle invalid command', () => {
        expect(() => {
            execSync('node src/cli.js invalidCommand');
        }).toThrow();
    });
});