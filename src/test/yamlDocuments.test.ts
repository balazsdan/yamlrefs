import { deepStrictEqual, equal, rejects } from 'node:assert/strict';
import * as vscode from 'vscode';

import { YamlDocumentParser, YamlDocumentStore } from '../yamlDocuments';
import { textDocument } from './helpers';

suite('YamlDocumentParser', () => {
    test('records scalar paths, values, and quote styles', () => {
        const parsed = new YamlDocumentParser().parse(textDocument([
            'items:',
            '  - plain: alpha',
            "    single: 'beta'",
            '    double: "gamma"',
            '    empty:'
        ].join('\n')));

        deepStrictEqual(parsed.scalars.map(scalar => ({
            path: scalar.path.join('/'),
            value: scalar.value,
            style: scalar.style
        })), [
            { path: 'items/0/plain', value: 'alpha', style: 'plain' },
            { path: 'items/0/single', value: 'beta', style: 'single-quoted' },
            { path: 'items/0/double', value: 'gamma', style: 'double-quoted' },
            { path: 'items/0/empty', value: undefined, style: 'plain' }
        ]);
    });

    test('accepts only non-empty string include entries', () => {
        const parsed = new YamlDocumentParser().parse(textDocument([
            '$include:',
            '  - ./valid.yaml',
            '  - ""',
            '  - 42'
        ].join('\n')));

        deepStrictEqual(parsed.includes.map(include => include.rawPath), ['./valid.yaml']);
        deepStrictEqual(parsed.issues.map(issue => issue.code), [
            'invalid-include',
            'invalid-include'
        ]);
    });

    test('requires one root-level include list', () => {
        const parser = new YamlDocumentParser();
        const scalar = parser.parse(textDocument('$include: ./one.yaml'));
        const duplicate = parser.parse(textDocument([
            '$include: []',
            '$include: []'
        ].join('\n')));

        equal(scalar.issues[0].message.startsWith('"$include" must be a list'), true);
        equal(duplicate.issues[0].message.startsWith('Only one root-level'), true);
    });

    test('reads includes from a configured root key', () => {
        const parsed = new YamlDocumentParser().parse(textDocument([
            '$include:',
            '  - ./ignored.yaml',
            'includes:',
            '  - ./custom.yaml'
        ].join('\n')), 'includes');

        deepStrictEqual(parsed.includes.map(include => include.rawPath), ['./custom.yaml']);
    });
});

suite('YamlDocumentStore', () => {
    test('caches by document version and supports invalidation', () => {
        class CountingParser extends YamlDocumentParser {
            calls = 0;

            override parse(document: vscode.TextDocument) {
                this.calls += 1;
                return super.parse(document);
            }
        }

        const parser = new CountingParser();
        const store = new YamlDocumentStore(parser);
        const document = textDocument('value: one');

        equal(store.get(document), store.get(document));
        equal(parser.calls, 1);
        store.invalidate(document.uri);
        store.get(document);
        store.clear();
        store.get(document);
        equal(parser.calls, 3);
    });

    test('invalidates cached documents when the include key changes', () => {
        const store = new YamlDocumentStore(new YamlDocumentParser());
        const document = textDocument([
            '$include:',
            '  - ./default.yaml',
            'includes:',
            '  - ./custom.yaml'
        ].join('\n'));

        deepStrictEqual(store.get(document).includes.map(include => include.rawPath), [
            './default.yaml'
        ]);
        store.configure('includes');
        deepStrictEqual(store.get(document).includes.map(include => include.rawPath), [
            './custom.yaml'
        ]);
    });

    test('honors cancellation before opening a document', async () => {
        const cancellation = new vscode.CancellationTokenSource();
        cancellation.cancel();

        await rejects(
            new YamlDocumentStore(new YamlDocumentParser()).open(
                vscode.Uri.parse('file:///missing.yaml'),
                cancellation.token
            ),
            vscode.CancellationError
        );
    });
});
