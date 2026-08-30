import { equal, ok } from 'node:assert/strict';
import * as vscode from 'vscode';

suite('extension functional', () => {
    test('activates in the VS Code host', async () => {
        const extension = vscode.extensions.getExtension('balazs.yamlrefs');

        ok(extension);
        await extension.activate();
        equal(extension.isActive, true);
    });
});
