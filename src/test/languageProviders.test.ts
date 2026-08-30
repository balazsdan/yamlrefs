import { deepStrictEqual, equal, match, strictEqual } from 'node:assert/strict';
import * as vscode from 'vscode';

import {
    DiagnosticsController,
    IncludeDefinitionProvider,
    ReferenceCompletionProvider,
    ReferenceDefinitionProvider,
    ReferenceHoverProvider,
    type WorkspaceSessionLookup
} from '../languageProviders';
import type { IndexedDefinitions } from '../model';
import { WorkspaceSession } from '../workspaceSession';
import { definition, occurrence, textDocument } from './helpers';

function lookup(session?: Partial<WorkspaceSession>): WorkspaceSessionLookup {
    return {
        sessionFor: () => session as WorkspaceSession | undefined
    };
}

function token(): vscode.CancellationToken {
    return new vscode.CancellationTokenSource().token;
}

const emptyIndex: IndexedDefinitions = {
    definitions: [],
    byValue: new Map(),
    issues: [],
    dependencies: []
};

suite('ReferenceCompletionProvider', () => {
    test('sorts values and deduplicates definition locations', async () => {
        const document = textDocument('current');
        const reference = occurrence(document, 'current');
        const jsonDocument = textDocument(
            'alpha',
            vscode.Uri.parse('file:///workspace/settings.json'),
            'json'
        );
        const yamlDocument = textDocument('zeta', vscode.Uri.parse('file:///workspace/items.yaml'));
        const alpha = definition('alpha', jsonDocument, 'external');
        const indexed: IndexedDefinitions = {
            definitions: [definition('zeta', yamlDocument), alpha, alpha],
            byValue: new Map(),
            issues: [],
            dependencies: []
        };
        const session = {
            findReferencesAt: () => [reference],
            candidates: async () => indexed
        };

        const items = await new ReferenceCompletionProvider(lookup(session))
            .provideCompletionItems(document, new vscode.Position(0, 0), token());

        deepStrictEqual(items.map(item =>
            (item.label as vscode.CompletionItemLabel).label), ['alpha', 'zeta']);
        equal(items[0].detail, 'item reference');
        equal(items[0].insertText, 'alpha');
        match((items[0].documentation as vscode.MarkdownString).value, /external&nbsp;JSON/);
    });

    test('returns no items without a workspace session', async () => {
        const document = textDocument('value');
        const items = await new ReferenceCompletionProvider(lookup())
            .provideCompletionItems(document, new vscode.Position(0, 0), token());

        deepStrictEqual(items, []);
    });
});

suite('ReferenceDefinitionProvider', () => {
    test('ignores empty references and deduplicates locations', async () => {
        const document = textDocument('known');
        const known = occurrence(document, 'known');
        const target = definition('known', document);
        let resolutions = 0;
        const session = {
            findReferencesAt: () => [known, occurrence(document, '')],
            resolve: async () => {
                resolutions += 1;
                return { matches: [target, target], indexed: emptyIndex };
            }
        };

        const locations = await new ReferenceDefinitionProvider(lookup(session))
            .provideDefinition(document, new vscode.Position(0, 0), token());

        equal(resolutions, 1);
        equal(locations.length, 1);
        equal(locations[0].uri.toString(), target.uri.toString());
    });
});

suite('ReferenceHoverProvider', () => {
    test('explains an unresolved reference', async () => {
        const document = textDocument('missing');
        const reference = occurrence(document, 'missing');
        const session = {
            findReferencesAt: () => [reference],
            resolve: async () => ({ matches: [], indexed: emptyIndex })
        };

        const hover = await new ReferenceHoverProvider(lookup(session))
            .provideHover(document, new vscode.Position(0, 0), token());

        strictEqual(hover?.range, reference.range);
        match(
            (hover?.contents[0] as vscode.MarkdownString).value,
            /No matching definition was found/
        );
    });
});

suite('IncludeDefinitionProvider', () => {
    test('points to the start of the resolved include', async () => {
        const document = textDocument('./child.yaml');
        const target = vscode.Uri.parse('file:///workspace/child.yaml');
        const session = { includeTargetAt: async () => target };

        const location = await new IncludeDefinitionProvider(lookup(session))
            .provideDefinition(document, new vscode.Position(0, 0), token());

        equal(location?.uri.toString(), target.toString());
        deepStrictEqual(location?.range.start, new vscode.Position(0, 0));
    });
});

suite('DiagnosticsController', () => {
    test('publishes config diagnostics and clears empty collections', () => {
        const configUri = vscode.Uri.parse('file:///workspace/.yamlrefs.json');
        let published: readonly vscode.Diagnostic[] | undefined;
        const deleted: string[] = [];
        const collection = {
            set: (_uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]) => {
                published = diagnostics;
            },
            delete: (uri: vscode.Uri) => {
                deleted.push(uri.toString());
            }
        } as unknown as vscode.DiagnosticCollection;
        const controller = new DiagnosticsController(collection, lookup());

        controller.publishConfigIssues({
            configUri,
            issues: [{
                uri: configUri,
                range: new vscode.Range(0, 0, 0, 1),
                message: 'Bad config.',
                severity: vscode.DiagnosticSeverity.Error
            }]
        } as unknown as WorkspaceSession);

        equal(published?.length, 1);
        equal(published?.[0].source, 'yamlrefs');
        equal(published?.[0].message, 'Bad config.');

        controller.publishConfigIssues({ configUri, issues: [] } as unknown as WorkspaceSession);
        controller.clear(configUri);
        deepStrictEqual(deleted, [configUri.toString(), configUri.toString()]);
        controller.dispose();
    });
});
