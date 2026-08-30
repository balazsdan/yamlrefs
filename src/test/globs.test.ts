import { deepStrictEqual, equal, rejects } from 'node:assert/strict';
import * as vscode from 'vscode';

import {
    compileGlobSet,
    findWorkspaceFiles,
    toYamlPath,
    validateGlob
} from '../globs';

suite('globs', () => {
    test('matches normalized paths with minimatch semantics', () => {
        const globs = compileGlobSet(['/items/{0,1}/**/id']);

        equal(globs.matches('\\items\\0\\nested\\id'), true);
        equal(globs.matches('/items/2/nested/id'), false);
        equal(validateGlob('/items/*/id'), undefined);
    });

    test('encodes YAML paths as JSON pointers', () => {
        equal(toYamlPath(['groups', 'a/b', '~name']), '/groups/a~1b/~0name');
        deepStrictEqual(toYamlPath([]), '/');
    });

    test('honors cancellation before searching the workspace', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        cancellation.cancel();

        await rejects(
            findWorkspaceFiles(vscode.Uri.parse('file:///workspace'), ['**/*.yaml'], cancellation.token),
            vscode.CancellationError
        );
    });
});
