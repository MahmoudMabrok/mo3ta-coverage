import { getJsOnlyFiles } from './fileUtils';

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