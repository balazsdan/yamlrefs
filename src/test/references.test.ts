import { deepStrictEqual, equal, strictEqual } from 'node:assert/strict';
import * as vscode from 'vscode';

import { DefinitionIndex } from '../definitionSources';
import { IncludeGraphResolver } from '../includeGraph';
import type { IndexedDefinitions, ParsedYamlDocument } from '../model';
import {
    formatYamlCompletion,
    formatYamlScalar,
    ReferenceResolver,
    ReferenceScanner,
    ReferenceValidator
} from '../references';
import { YamlDocumentStore } from '../yamlDocuments';
import { context, definition, occurrence, textDocument } from './helpers';

function storeWith(parsed: ParsedYamlDocument): YamlDocumentStore {
    return { get: () => parsed } as unknown as YamlDocumentStore;
}

suite('YAML value formatting', () => {
    test('preserves quote style and protects unsafe plain scalars', () => {
        deepStrictEqual([
            formatYamlScalar('header.main', 'plain'),
            formatYamlScalar('true', 'plain'),
            formatYamlScalar("editor's", 'single-quoted'),
            formatYamlScalar('line\nbreak', 'double-quoted'),
            formatYamlCompletion('next', 'single-quoted')
        ], [
            'header.main',
            '"true"',
            "'editor''s'",
            '"line\\nbreak"',
            "next'"
        ]);
    });
});

suite('ReferenceScanner', () => {
    test('applies internal and external path rules with correct replacement ranges', () => {
        const document = textDocument("'alpha' beta");
        const parsed: ParsedYamlDocument = {
            uri: document.uri,
            document,
            includes: [],
            issues: [],
            scalars: [
                { path: ['refs', '0'], value: 'alpha', start: 0, end: 7, style: 'single-quoted' },
                { path: ['other'], value: 'beta', start: 8, end: 12, style: 'plain' }
            ]
        };
        const scanner = new ReferenceScanner(storeWith(parsed));
        scanner.configure({
            version: 1,
            definitions: {
                item: { paths: ['/items/*'], references: ['/refs/*'] }
            },
            externalDefinitions: {
                other: {
                    references: ['/other'],
                    source: { type: 'fake', files: ['*.fake'] }
                }
            }
        });

        const found = scanner.scan(document);
        deepStrictEqual(found.map(item => item.definitionName), ['item', 'other']);
        equal(document.getText(found[0].replacementRange), "alpha'");
        equal(document.getText(found[1].replacementRange), 'beta');

        scanner.configure(undefined);
        deepStrictEqual(scanner.scan(document), []);
    });

    test('findAt returns only the deepest overlapping scalar', () => {
        const document = textDocument('value ');
        const parsed: ParsedYamlDocument = {
            uri: document.uri,
            document,
            includes: [],
            issues: [],
            scalars: [
                { path: ['a'], value: 'value', start: 0, end: 5, style: 'plain' },
                { path: ['a', 'b'], value: 'value', start: 0, end: 5, style: 'plain' }
            ]
        };
        const scanner = new ReferenceScanner(storeWith(parsed));
        scanner.configure({
            version: 1,
            definitions: {
                shallow: { paths: ['/unused'], references: ['/a'] },
                deep: { paths: ['/unused'], references: ['/a/b'] }
            },
            externalDefinitions: {}
        });

        deepStrictEqual(
            scanner.findAt(document, document.positionAt(2)).map(item => item.definitionName),
            ['deep']
        );
        deepStrictEqual(scanner.findAt(document, document.positionAt(6)), []);
    });
});

suite('ReferenceResolver', () => {
    test('returns candidates and matches by exact value', async () => {
        const document = textDocument('known');
        const record = definition('known', document);
        const indexed: IndexedDefinitions = {
            definitions: [record],
            byValue: new Map([['known', [record]]]),
            issues: [],
            dependencies: []
        };
        const index = { get: async () => indexed } as unknown as DefinitionIndex;
        const resolver = new ReferenceResolver(index);
        const reference = occurrence(document);

        strictEqual(await resolver.candidates(reference, context(document)), indexed);
        deepStrictEqual(
            (await resolver.resolve(reference, context(document))).matches,
            [record]
        );
        deepStrictEqual(
            (await resolver.resolve({ ...reference, value: 'missing' }, context(document))).matches,
            []
        );
    });
});

suite('ReferenceValidator', () => {
    test('combines local include issues with unknown references', async () => {
        const document = textDocument('missing');
        const reference = occurrence(document, 'missing');
        const scanner = { scan: () => [reference] } as unknown as ReferenceScanner;
        const resolver = {
            resolve: async () => ({
                matches: [],
                indexed: { definitions: [], byValue: new Map(), issues: [], dependencies: [] }
            })
        } as unknown as ReferenceResolver;
        const includes = {
            resolve: async () => ({
                documents: [],
                dependencies: [],
                issues: [{
                    uri: document.uri,
                    message: 'Bad include.',
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'invalid-include' as const
                }, {
                    uri: vscode.Uri.parse('file:///other.yaml'),
                    message: 'Other file issue.',
                    severity: vscode.DiagnosticSeverity.Error
                }]
            })
        } as unknown as IncludeGraphResolver;

        const issues = await new ReferenceValidator(scanner, resolver, includes)
            .validate(document, context(document));

        deepStrictEqual(issues.map(issue => issue.code), [
            'invalid-include',
            'unknown-reference'
        ]);
    });

    test('deduplicates source failures and suppresses unknown-reference noise', async () => {
        const document = textDocument('first second');
        const references = [
            occurrence(document, 'first'),
            { ...occurrence(document, 'second'), start: 6, end: 12 }
        ];
        const sourceIssue = {
            uri: vscode.Uri.parse('file:///source.json'),
            message: 'Invalid JSON.',
            severity: vscode.DiagnosticSeverity.Error,
            code: 'source-error' as const
        };
        const scanner = { scan: () => references } as unknown as ReferenceScanner;
        const resolver = {
            resolve: async () => ({
                matches: [],
                indexed: {
                    definitions: [],
                    byValue: new Map(),
                    issues: [sourceIssue],
                    dependencies: []
                }
            })
        } as unknown as ReferenceResolver;
        const includes = {
            resolve: async () => ({ documents: [], dependencies: [], issues: [] })
        } as unknown as IncludeGraphResolver;

        const issues = await new ReferenceValidator(scanner, resolver, includes)
            .validate(document, context(document));

        equal(issues.length, 1);
        equal(issues[0].code, 'source-error');
        equal(issues[0].uri.toString(), document.uri.toString());
        equal(issues[0].message, 'Definition source "item": Invalid JSON.');
    });
});
