import { getJsOnlyFiles, separateSourceAndTestFiles, findTestFilesForSource } from './fileUtils';
import fs from 'fs';

describe('getJsOnlyFiles', () => {
    const files = [
        'src/app.js',
        'src/utils.ts',
        'src/component.jsx',
        'src/page.tsx',
        'src/app.test.js',
        'src/utils.spec.ts',
        'src/config/jest.config.js',
        'src/config/babel.config.js',
        'src/config/webpack.config.js',
        'src/config/tsconfig.json',
        'src/config/eslint.config.js',
        'src/config/prettier.config.js',
        'src/config/rollup.config.js',
        'src/config/vite.config.js',
        'src/package.json',
        'src/data.json',
        'README.md',
        'src/styles.css'
    ];

    it('should include only source code files and exclude test, config, and json files', () => {
        const result = getJsOnlyFiles(files, false);
        expect(result).toEqual([
            'src/app.js',
            'src/utils.ts',
            'src/component.jsx',
            'src/page.tsx'
        ]);
    });

    it('should exclude all files except test files when runTestsOnly is true', () => {
        const result = getJsOnlyFiles(files, true);
        expect(result).toEqual([
            'src/app.test.js',
            'src/utils.spec.ts',
        ]);
    });

    it('should return empty array if no files match', () => {
        const result = getJsOnlyFiles(['README.md', 'src/styles.css'], false);
        expect(result).toEqual([]);
    });

    it('should exclude .json files', () => {
        const result = getJsOnlyFiles(['src/data.json', 'src/app.js'], false);
        expect(result).toEqual(['src/app.js']);
    });

    it('should exclude config files', () => {
        const configFiles = [
            'jest.config.js',
            'babel.config.js',
            'webpack.config.js',
            'tsconfig.json',
            'eslint.config.js',
            'prettier.config.js',
            'rollup.config.js',
            'vite.config.js',
            'package.json'
        ];
        const result = getJsOnlyFiles(configFiles, false);
        expect(result).toEqual([]);
    });

    it('should include only .js, .ts, .jsx, .tsx files', () => {
        const result = getJsOnlyFiles([
            'src/app.js',
            'src/utils.ts',
            'src/component.jsx',
            'src/page.tsx',
            'src/other.txt'
        ], false);
        expect(result).toEqual([
            'src/app.js',
            'src/utils.ts',
            'src/component.jsx',
            'src/page.tsx'
        ]);
    });
});

describe('separateSourceAndTestFiles', () => {
    it('should separate source and test files correctly', () => {
        const files = [
            'src/app.js',
            'src/utils.ts',
            'src/app.test.js',
            'src/utils.spec.ts',
            'src/component.jsx',
            'src/component.test.jsx'
        ];
        
        const result = separateSourceAndTestFiles(files);
        
        expect(result.sourceFiles).toEqual([
            'src/app.js',
            'src/utils.ts',
            'src/component.jsx'
        ]);
        expect(result.testFiles).toEqual([
            'src/app.test.js',
            'src/utils.spec.ts',
            'src/component.test.jsx'
        ]);
    });

    it('should exclude config and json files', () => {
        const files = [
            'src/app.js',
            'jest.config.js',
            'package.json',
            'src/data.json'
        ];
        
        const result = separateSourceAndTestFiles(files);
        
        expect(result.sourceFiles).toEqual(['src/app.js']);
        expect(result.testFiles).toEqual([]);
    });

    it('should handle empty array', () => {
        const result = separateSourceAndTestFiles([]);
        
        expect(result.sourceFiles).toEqual([]);
        expect(result.testFiles).toEqual([]);
    });

    it('should handle all test files', () => {
        const files = [
            'src/app.test.js',
            'src/utils.spec.ts'
        ];
        
        const result = separateSourceAndTestFiles(files);
        
        expect(result.sourceFiles).toEqual([]);
        expect(result.testFiles).toEqual([
            'src/app.test.js',
            'src/utils.spec.ts'
        ]);
    });
});

describe('findTestFilesForSource', () => {
    // Mock fs.existsSync for testing
    const originalExistsSync = fs.existsSync;
    
    beforeEach(() => {
        // Reset mock before each test
        fs.existsSync = jest.fn();
    });

    afterEach(() => {
        // Restore original function
        fs.existsSync = originalExistsSync;
    });

    it('should find test file in same directory with .test.js pattern', () => {
        fs.existsSync.mockImplementation((path) => {
            return path === 'src/utils/helper.test.js';
        });

        const result = findTestFilesForSource('src/utils/helper.js');
        
        expect(result).toContain('src/utils/helper.test.js');
    });

    it('should find test file in __tests__ subdirectory', () => {
        fs.existsSync.mockImplementation((path) => {
            return path === 'src/utils/__tests__/helper.test.js';
        });

        const result = findTestFilesForSource('src/utils/helper.js');
        
        expect(result).toContain('src/utils/__tests__/helper.test.js');
    });

    it('should find multiple test files if they exist', () => {
        fs.existsSync.mockImplementation((path) => {
            return path === 'src/utils/helper.test.js' || 
                   path === 'src/utils/helper.spec.js';
        });

        const result = findTestFilesForSource('src/utils/helper.js');
        
        expect(result).toContain('src/utils/helper.test.js');
        expect(result).toContain('src/utils/helper.spec.js');
        expect(result.length).toBe(2);
    });

    it('should return empty array if no test files exist', () => {
        fs.existsSync.mockReturnValue(false);

        const result = findTestFilesForSource('src/utils/helper.js');
        
        expect(result).toEqual([]);
    });

    it('should find test files in parallel tests directory structure', () => {
        fs.existsSync.mockImplementation((path) => {
            // path.join normalizes paths, removing leading './'
            return path === 'src/tests/utils/helper.test.js';
        });

        const result = findTestFilesForSource('./src/utils/helper.js');
        
        expect(result).toContain('src/tests/utils/helper.test.js');
    });

    it('should handle TypeScript files', () => {
        fs.existsSync.mockImplementation((path) => {
            return path === 'src/utils/helper.test.ts';
        });

        const result = findTestFilesForSource('src/utils/helper.ts');
        
        expect(result).toContain('src/utils/helper.test.ts');
    });

    it('should handle JSX files', () => {
        fs.existsSync.mockImplementation((path) => {
            return path === 'src/components/Button.test.jsx';
        });

        const result = findTestFilesForSource('src/components/Button.jsx');
        
        expect(result).toContain('src/components/Button.test.jsx');
    });
});