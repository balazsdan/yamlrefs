import { deepStrictEqual, equal, match } from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { ExternalSourceRegistry } from '../definitionSources';
import { IniDefinitionSourceFactory } from '../ini';
import { JsonDefinitionSourceFactory } from '../json';
import { WorkspaceSession } from '../workspaceSession';

async function exampleSession(name: string): Promise<WorkspaceSession> {
    const sources = new ExternalSourceRegistry();
    sources.register(new IniDefinitionSourceFactory());
    sources.register(new JsonDefinitionSourceFactory());
    const folder = {
        uri: vscode.Uri.file(path.resolve(__dirname, '..', '..', 'examples', name)),
        name,
        index: 0
    };
    const session = new WorkspaceSession(folder, sources);
    await session.initialize();
    return session;
}

suite('WorkspaceSession functional', () => {
    test('resolves definitions through transitive includes using the configured key', async () => {
        const session = await exampleSession('includes');
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.joinPath(session.folder.uri, 'workflow.yaml')
        );

        try {
            deepStrictEqual(session.issues, []);
            const running = document.getText().indexOf('running');
            const [reference] = session.findReferencesAt(document, document.positionAt(running));
            const resolved = await session.resolve(document, reference);

            equal(resolved.matches.length, 1);
            match(resolved.matches[0].uri.path, /states\.yaml$/);
            deepStrictEqual((await session.validate(document)).map(issue => issue.code), [
                'unknown-reference'
            ]);

            const include = document.getText().indexOf('./domain.yaml');
            const target = await session.includeTargetAt(document, document.positionAt(include));
            match(target?.path ?? '', /domain\.yaml$/);
        } finally {
            session.dispose();
        }
    });

    test('resolves external JSON and INI definitions', async () => {
        const session = await exampleSession('external-sources');
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.joinPath(session.folder.uri, 'pages.yaml')
        );

        try {
            const values = ['light', 'production'];
            const sourceFiles: string[] = [];
            for (const value of values) {
                const offset = document.getText().indexOf(value);
                const [reference] = session.findReferencesAt(document, document.positionAt(offset));
                const [resolved] = (await session.resolve(document, reference)).matches;
                sourceFiles.push(resolved.uri.path.split('/').pop() ?? '');
            }

            deepStrictEqual(sourceFiles, ['themes.json', 'environments.ini']);
            deepStrictEqual((await session.validate(document)).map(issue => issue.message), [
                'Unknown theme reference "does-not-exist".'
            ]);
        } finally {
            session.dispose();
        }
    });
});
