import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out/test/**/*.test.js',

    version: '1.110.0',

    launchArgs: [
        '--disable-extensions',
        '--disable-telemetry',
        '--disable-experiments',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
    ],
});
