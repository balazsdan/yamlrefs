import { deepStrictEqual, equal } from 'node:assert/strict';
import * as vscode from 'vscode';

import { IncludeGraphResolver } from '../includeGraph';
import type { ParsedYamlDocument } from '../model';
import { YamlDocumentParser, YamlDocumentStore } from '../yamlDocuments';
import { textDocument } from './helpers';

function parsed(uri: string, text: string): ParsedYamlDocument {
    return new YamlDocumentParser().parse(textDocument(text, vscode.Uri.parse(uri)));
}

function resolverFor(
    root: ParsedYamlDocument,
    included: readonly ParsedYamlDocument[]
): { resolver: IncludeGraphResolver; opened: string[] } {
    const documents = new Map(included.map(document => [document.uri.toString(), document]));
    const opened: string[] = [];
    const store = {
        get: () => root,
        open: async (uri: vscode.Uri) => {
            opened.push(uri.toString());
            const document = documents.get(uri.toString());
            if (!document) {
                throw new Error('missing');
            }
            return document;
        }
    } as unknown as YamlDocumentStore;

    return { resolver: new IncludeGraphResolver(store), opened };
}

suite('IncludeGraphResolver', () => {
    test('resolves transitive includes once', async () => {
        const root = parsed('file:///workspace/root.yaml', [
            '$include:',
            '  - ./child.yaml',
            '  - ./child.yaml'
        ].join('\n'));
        const child = parsed('file:///workspace/child.yaml', [
            '$include:',
            '  - .\\nested\\leaf.yaml'
        ].join('\n'));
        const leaf = parsed('file:///workspace/nested/leaf.yaml', 'value: leaf');
        const { resolver, opened } = resolverFor(root, [child, leaf]);

        const graph = await resolver.resolve(root.document);

        deepStrictEqual(
            graph.documents.map(document => document.uri.path),
            ['/workspace/root.yaml', '/workspace/child.yaml', '/workspace/nested/leaf.yaml']
        );
        deepStrictEqual(graph.issues, []);
        equal(opened.filter(uri => uri.endsWith('/child.yaml')).length, 1);
    });

    test('reports circular and missing includes', async () => {
        const root = parsed('file:///workspace/root.yaml', [
            '$include:',
            '  - ./child.yaml',
            '  - ./missing.yaml'
        ].join('\n'));
        const child = parsed('file:///workspace/child.yaml', [
            '$include:',
            '  - ./root.yaml'
        ].join('\n'));
        const { resolver } = resolverFor(root, [child]);

        const graph = await resolver.resolve(root.document);

        deepStrictEqual(graph.issues.map(issue => issue.code), [
            'circular-include',
            'missing-include'
        ]);
        equal(graph.dependencies.some(uri => uri.path.endsWith('/missing.yaml')), true);
    });
});
