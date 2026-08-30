import {
    deepStrictEqual,
    equal,
    rejects,
    strictEqual,
    throws
} from 'node:assert/strict';
import * as vscode from 'vscode';

import {
    DefinitionIndex,
    type DefinitionSource,
    ExternalSourceRegistry,
    type ExternalDefinitionSourceFactory,
    InternalYamlDefinitionSource
} from '../definitionSources';
import { IncludeGraphResolver } from '../includeGraph';
import type { ExternalSourceConfig } from '../model';
import { YamlDocumentParser } from '../yamlDocuments';
import { context, definition, textDocument } from './helpers';

suite('ExternalSourceRegistry', () => {
    test('owns factory registration, validation, and creation', () => {
        const source = { collect: async () => ({ definitions: [], issues: [], dependencies: [] }) };
        const factory: ExternalDefinitionSourceFactory = {
            type: 'fake',
            validate: () => ['factory problem'],
            create: () => source
        };
        const registry = new ExternalSourceRegistry();
        const registration = registry.register(factory);
        const config: ExternalSourceConfig = { type: 'fake', files: ['*.fake'] };

        equal(registry.has('fake'), true);
        deepStrictEqual(registry.validate(config), ['factory problem']);
        strictEqual(registry.create('item', config), source);
        throws(() => registry.register(factory), /already registered/);

        registration.dispose();
        equal(registry.has('fake'), false);
        deepStrictEqual(registry.validate(config), [
            'Unknown external definition source type "fake".'
        ]);
    });
});

suite('InternalYamlDefinitionSource', () => {
    test('collects matching scalar values from the include graph', async () => {
        const document = textDocument([
            'items:',
            '  - id: one',
            '  - id: two',
            'ignored: three'
        ].join('\n'));
        const parsed = new YamlDocumentParser().parse(document);
        const issue = {
            uri: document.uri,
            message: 'include warning',
            severity: vscode.DiagnosticSeverity.Warning
        };
        const includes = {
            resolve: async () => ({
                documents: [parsed],
                issues: [issue],
                dependencies: [document.uri]
            })
        } as unknown as IncludeGraphResolver;
        const source = new InternalYamlDefinitionSource('item', ['/items/*/id'], includes);

        const result = await source.collect(context(document));

        deepStrictEqual(result.definitions.map(item => item.value), ['one', 'two']);
        equal(result.definitions.every(item => item.origin === 'internal'), true);
        deepStrictEqual(result.issues, [issue]);
        deepStrictEqual(result.dependencies, [document.uri]);
    });
});

suite('DefinitionIndex', () => {
    test('indexes values and invalidates its cache', async () => {
        const document = textDocument('same');
        let collections = 0;
        const source: DefinitionSource = {
            collect: async () => {
                collections += 1;
                return {
                    definitions: [
                        definition('same', document),
                        { ...definition('same', document), uri: vscode.Uri.parse('file:///other.yaml') }
                    ],
                    issues: [],
                    dependencies: []
                };
            }
        };
        const index = new DefinitionIndex();
        index.configure(new Map([['item', source]]));

        const first = await index.get('item', context(document));
        strictEqual(await index.get('item', context(document)), first);
        equal(collections, 1);
        equal(first.byValue.get('same')?.length, 2);
        equal((await index.find('item', 'same', context(document))).length, 2);

        index.invalidate(document.uri);
        await index.get('item', context(document));
        equal(collections, 2);

        index.clear();
        const missing = await index.get('item', context(document));
        deepStrictEqual(missing.issues.map(issue => issue.code), ['source-error']);
    });

    test('converts source failures but preserves cancellation', async () => {
        const document = textDocument('value');
        const failed = new DefinitionIndex();
        failed.configure(new Map([['item', {
            collect: async () => { throw new Error('boom'); }
        }]]));

        const result = await failed.get('item', context(document));
        equal(result.issues[0].message, 'Definition source "item" failed: boom');

        const cancelled = new DefinitionIndex();
        cancelled.configure(new Map([['item', {
            collect: async () => { throw new vscode.CancellationError(); }
        }]]));
        await rejects(
            cancelled.get('item', context(document)),
            vscode.CancellationError
        );
    });
});
