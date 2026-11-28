import {
    getJsOnlyFiles,
    separateSourceAndTestFiles,
    findTestFilesForSource,
    findTestFilesByImport,
    findRelatedTestFilesBySource
} from './fileUtils';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
describe('findTestFilesByImport', () => {
    let tempDir;

    function createFixture(structure) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-import-'));
        Object.entries(structure).forEach(([filePath, content]) => {
            const absolutePath = path.join(tempDir, filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, content);
        });
        return tempDir;
    }

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('finds a spec file with a different name that imports the source file', () => {
        const root = createFixture({
            'src/utils/helper.js': 'export const add = (a, b) => a + b;',
            'src/utils/custom-name.spec.js': "import { add } from './helper';\n"
        });

        const result = findTestFilesByImport('src/utils/helper.js', root);

        expect(result).toEqual(['src/utils/custom-name.spec.js']);
    });

    it('resolves imports with explicit extensions', () => {
        const root = createFixture({
            'src/utils/helper.ts': 'export const add = (a, b) => a + b;',
            'src/renamed.test.ts': "import { add } from './utils/helper.js';\n"
        });

        const result = findTestFilesByImport('src/utils/helper.ts', root);

        expect(result).toEqual(['src/renamed.test.ts']);
    });

    it('matches alias imports by path suffix', () => {
        const root = createFixture({
            'src/utils/helper.js': 'export const add = (a, b) => a + b;',
            'src/alias.test.js': "import { add } from '@/utils/helper';\n"
        });

        const result = findTestFilesByImport('src/utils/helper.js', root);

        expect(result).toEqual(['src/alias.test.js']);
    });

    it('resolves directory imports to the source file index', () => {
        const root = createFixture({
            'src/utils/index.js': "export * from './helper';",
            'src/utils/helper.js': 'export const add = (a, b) => a + b;',
            'src/index-import.test.js': "import { add } from './utils';\n"
        });

        const result = findTestFilesByImport('src/utils/index.js', root);

        expect(result).toEqual(['src/index-import.test.js']);
    });

    it('returns empty array when no test file imports the source', () => {
        const root = createFixture({
            'src/utils/helper.js': 'export const add = (a, b) => a + b;',
            'src/unrelated.test.js': "import { other } from './other';\n"
        });

        const result = findTestFilesByImport('src/utils/helper.js', root);

        expect(result).toEqual([]);
    });

    it('skips node_modules when scanning', () => {
        const root = createFixture({
            'src/utils/helper.js': 'export const add = (a, b) => a + b;',
            'node_modules/pkg/dep.test.js': "import { add } from '../../src/utils/helper';\n",
            'src/real.test.js': "import { add } from './utils/helper';\n"
        });

        const result = findTestFilesByImport('src/utils/helper.js', root);

        expect(result).toEqual(['src/real.test.js']);
    });
});

describe('findRelatedTestFilesBySource', () => {
    let tempDir;

    function createFixture(structure) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-related-'));
        Object.entries(structure).forEach(([filePath, content]) => {
            const absolutePath = path.join(tempDir, filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, content);
        });
        return tempDir;
    }

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('includes same-name test files and differently named importer specs', () => {
        const root = createFixture({
            'src/widget.js': 'export const widget = 1;',
            'src/widget.test.js': "import { widget } from './widget';\n",
            'src/integration.spec.js': "import { widget } from './widget';\n"
        });

        const result = findRelatedTestFilesBySource('src/widget.js', { root });

        expect(result).toEqual(['src/integration.spec.js', 'src/widget.test.js']);
    });

    it('finds a direct importer at depth 1', () => {
        const root = createFixture({
            'lib/helper.js': 'export const add = (a, b) => a + b;',
            'lib/custom-name.spec.js': "import { add } from './helper';\n"
        });

        const result = findRelatedTestFilesBySource('lib/helper.js', { root, maxDepth: 1 });

        expect(result).toEqual(['lib/custom-name.spec.js']);
    });

    it('finds a spec that reaches the source through one intermediate module at depth 2', () => {
        const root = createFixture({
            'lib/helper.js': 'export const add = (a, b) => a + b;',
            'lib/service.js': "import { add } from './helper';\nexport const run = () => add(1, 2);\n",
            'lib/feature.spec.js': "import { run } from './service';\n"
        });

        const depthOne = findRelatedTestFilesBySource('lib/helper.js', { root, maxDepth: 1 });
        const depthTwo = findRelatedTestFilesBySource('lib/helper.js', { root, maxDepth: 2 });

        expect(depthOne).toEqual([]);
        expect(depthTwo).toEqual(['lib/feature.spec.js']);
    });

    it('finds specs that import the source through a barrel index', () => {
        const root = createFixture({
            'src/utils/helper.js': 'export const add = (a, b) => a + b;',
            'src/utils/index.js': "export * from './helper';\n",
            'src/app.test.js': "import { add } from './utils';\n"
        });

        const result = findRelatedTestFilesBySource('src/utils/helper.js', { root, maxDepth: 2 });

        expect(result).toEqual(['src/app.test.js']);
    });

    it('resolves alias imports while walking the graph', () => {
        const root = createFixture({
            'src/utils/helper.js': 'export const add = (a, b) => a + b;',
            'src/services/user.js': "import { add } from '@/utils/helper';\nexport const total = () => add(1, 1);\n",
            'src/user.spec.js': "import { total } from './services/user';\n"
        });

        const result = findRelatedTestFilesBySource('src/utils/helper.js', { root, maxDepth: 2 });

        expect(result).toEqual(['src/user.spec.js']);
    });

    it('does not return unrelated test files', () => {
        const root = createFixture({
            'src/utils/helper.js': 'export const add = (a, b) => a + b;',
            'src/unrelated.test.js': "import { other } from './other';\n",
            'src/other.js': 'export const other = 1;'
        });

        const result = findRelatedTestFilesBySource('src/utils/helper.js', { root, maxDepth: 2 });

        expect(result).toEqual([]);
    });

    it('resolves cross-lib relative imports and dotted filenames', () => {
        const root = createFixture({
            'libs/shared/src/date.utils.ts': 'export const formatDate = () => "2026";',
            'libs/app/src/auth.service.ts': "import { formatDate } from '../../shared/src/date.utils';\nexport const login = () => formatDate();\n",
            'libs/app/src/login.spec.ts': "import { login } from './auth.service';\n"
        });

        const result = findRelatedTestFilesBySource('libs/shared/src/date.utils.ts', { root, maxDepth: 2 });

        expect(result).toEqual(['libs/app/src/login.spec.ts']);
    });

    it('resolves tsconfig.base.json paths with JSONC comments and trailing commas', () => {
        const root = createFixture({
            'tsconfig.base.json': `{
              // root monorepo config
              "compilerOptions": {
                "baseUrl": ".",
                /* preserve glob patterns inside strings */
                "paths": {
                  "@myorg/shared": ["libs/shared/src/index.ts"],
                  "@myorg/shared/*": ["libs/shared/src/*"],
                },
              },
            }`,
            'libs/shared/src/index.ts': "export * from './math';\n",
            'libs/shared/src/math.ts': 'export const add = (a, b) => a + b;',
            'libs/app/src/calc.ts': "import { add } from '@myorg/shared/math';\nexport const run = () => add(1, 2);\n",
            'libs/app/src/calc.test.ts': "import { run } from './calc';\n",
            'libs/app/src/barrel.spec.ts': "import { add } from '@myorg/shared';\n"
        });

        const directSubpath = findRelatedTestFilesBySource('libs/shared/src/math.ts', { root, maxDepth: 2 });
        const viaBarrelDepth3 = findRelatedTestFilesBySource('libs/shared/src/math.ts', { root, maxDepth: 3 });

        expect(directSubpath).toEqual(['libs/app/src/barrel.spec.ts', 'libs/app/src/calc.test.ts']);
        expect(viaBarrelDepth3).toEqual(['libs/app/src/barrel.spec.ts', 'libs/app/src/calc.test.ts']);
    });

    it('scopes per-package @/* tsconfig paths while inheriting monorepo paths', () => {
        const root = createFixture({
            'tsconfig.base.json': JSON.stringify({
                compilerOptions: {
                    baseUrl: '.',
                    paths: {
                        '@myorg/shared': ['libs/shared/src/index.ts']
                    }
                }
            }),
            'libs/shared/tsconfig.json': JSON.stringify({
                extends: '../../tsconfig.base.json',
                compilerOptions: {
                    baseUrl: '.',
                    paths: {
                        '@/*': ['src/*']
                    }
                }
            }),
            'libs/app/tsconfig.json': JSON.stringify({
                extends: '../../tsconfig.base.json',
                compilerOptions: {
                    baseUrl: '.',
                    paths: {
                        '@/*': ['src/*']
                    }
                }
            }),
            'libs/shared/src/helper.ts': 'export const helper = () => 1;',
            'libs/shared/src/index.ts': "export { helper } from '@/helper';\n",
            'libs/app/src/helper.ts': 'export const appHelper = () => 2;',
            'libs/app/src/app.service.ts': "import { helper } from '@myorg/shared';\nimport { appHelper } from '@/helper';\nexport const run = () => helper() + appHelper();\n",
            'libs/app/src/app.spec.ts': "import { run } from './app.service';\n"
        });

        // Changing libs/app/src/helper.ts should only hit app.spec.ts, not shared's index.
        expect(findRelatedTestFilesBySource('libs/app/src/helper.ts', { root, maxDepth: 2 })).toEqual([
            'libs/app/src/app.spec.ts'
        ]);

        // Changing libs/shared/src/helper.ts walks:
        //   libs/shared/src/helper.ts -> libs/shared/src/index.ts (depth 1)
        //   -> libs/app/src/app.service.ts (depth 2) -> libs/app/src/app.spec.ts (depth 3).
        expect(findRelatedTestFilesBySource('libs/shared/src/helper.ts', { root, maxDepth: 2 })).toEqual([]);
        expect(findRelatedTestFilesBySource('libs/shared/src/helper.ts', { root, maxDepth: 3 })).toEqual([
            'libs/app/src/app.spec.ts'
        ]);
    });

    it('resolves workspace package.json names via main (dist->src) and exports wildcards', () => {
        const root = createFixture({
            'packages/utils/package.json': JSON.stringify({
                name: '@myorg/utils',
                main: './dist/index.js',
                exports: {
                    '.': {
                        import: './dist/index.js'
                    },
                    './*': './src/*.ts'
                }
            }),
            'packages/utils/src/index.ts': "export * from './format';\n",
            'packages/utils/src/format.ts': 'export const fmt = s => s.trim();',
            'packages/web/src/view.ts': "import { fmt } from '@myorg/utils';\nexport const render = () => fmt(' hi ');\n",
            'packages/web/src/view.test.ts': "import { render } from './view';\n",
            'packages/web/src/subpath.test.ts': "import { fmt } from '@myorg/utils/format';\n"
        });

        expect(findRelatedTestFilesBySource('packages/utils/src/format.ts', { root, maxDepth: 3 })).toEqual([
            'packages/web/src/subpath.test.ts',
            'packages/web/src/view.test.ts'
        ]);
        expect(findTestFilesByImport('packages/utils/src/format.ts', root)).toEqual([
            'packages/web/src/subpath.test.ts'
        ]);
    });

    it('resolves non-relative barrel directory imports and jest helper imports', () => {
        const root = createFixture({
            'src/utils/index.ts': 'export const ok = true;',
            'src/a.test.ts': "import { ok } from '@/utils';\n",
            'src/b.test.ts': "jest.doMock('@/utils');\nconst mod = jest.requireActual('@/utils');\n"
        });

        expect(findRelatedTestFilesBySource('src/utils/index.ts', { root, maxDepth: 1 })).toEqual([
            'src/a.test.ts',
            'src/b.test.ts'
        ]);
        expect(findTestFilesByImport('src/utils/index.ts', root)).toEqual([
            'src/a.test.ts',
            'src/b.test.ts'
        ]);
    });

    it('does not falsely match third-party scoped packages against local files', () => {
        const root = createFixture({
            'src/react.ts': 'export const localReact = 1;',
            'src/core.ts': 'export const localCore = 1;',
            'src/app.test.ts': "import { render } from '@testing-library/react';\nimport babel from '@babel/core';\n"
        });

        expect(findRelatedTestFilesBySource('src/react.ts', { root, maxDepth: 2 })).toEqual([]);
        expect(findRelatedTestFilesBySource('src/core.ts', { root, maxDepth: 2 })).toEqual([]);
    });
});
