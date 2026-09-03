import { deepStrictEqual, equal } from 'node:assert/strict';
import * as vscode from 'vscode';

import { ConfigLoader, ConfigValidator } from '../config';
import { ExternalSourceRegistry } from '../definitionSources';
import { IniDefinitionSourceFactory } from '../ini';
import { JsonDefinitionSourceFactory } from '../json';

function validator(): ConfigValidator {
    const sources = new ExternalSourceRegistry();
    sources.register(new IniDefinitionSourceFactory());
    sources.register(new JsonDefinitionSourceFactory());
    return new ConfigValidator(sources);
}

suite('ConfigValidator', () => {
    test('defaults omitted definition collections', () => {
        deepStrictEqual(validator().validate({ version: 1 }), {
            config: {
                version: 1,
                includeKey: '$include',
                definitions: {},
                externalDefinitions: {}
            },
            problems: []
        });
    });

    test('accepts a custom include key', () => {
        deepStrictEqual(validator().validate({ version: 1, includeKey: 'includes' }), {
            config: {
                version: 1,
                includeKey: 'includes',
                definitions: {},
                externalDefinitions: {}
            },
            problems: []
        });
    });

    const invalidCases: readonly [string, unknown, string][] = [
        ['requires an object root', [], 'The configuration root must be a JSON object.'],
        ['requires version 1', { version: 2 }, 'Configuration "version" must be 1.'],
        [
            'requires a non-empty include key',
            { version: 1, includeKey: '  ' },
            'Configuration "includeKey" must be a non-empty string.'
        ],
        [
            'requires a string include key',
            { version: 1, includeKey: null },
            'Configuration "includeKey" must be a non-empty string.'
        ],
        [
            'requires internal paths',
            { version: 1, definitions: { item: { paths: [], references: ['/item'] } } },
            'Internal definition "item" requires a non-empty "paths" array.'
        ],
        [
            'delegates external source validation',
            {
                version: 1,
                externalDefinitions: {
                    item: {
                        references: ['/item'],
                        source: { type: 'json', files: ['*.json'] }
                    }
                }
            },
            'External definition "item": JSON source "paths" must be a non-empty array of path glob strings.'
        ]
    ];

    for (const [name, raw, problem] of invalidCases) {
        test(name, () => {
            const result = validator().validate(raw);
            equal(result.config, undefined);
            deepStrictEqual(result.problems, [problem]);
        });
    }

    test('rejects a name shared by internal and external definitions', () => {
        const result = validator().validate({
            version: 1,
            definitions: {
                item: { paths: ['/items/*/id'], references: ['/item'] }
            },
            externalDefinitions: {
                item: {
                    references: ['/item'],
                    source: {
                        type: 'json',
                        files: ['*.json'],
                        paths: ['/items/*/id']
                    }
                }
            }
        });

        deepStrictEqual(result.problems, [
            'Definition name "item" is used by both internal and external definitions.'
        ]);
    });
});

suite('ConfigLoader', () => {
    test('recognizes only the workspace-root config file', () => {
        const folder = {
            uri: vscode.Uri.parse('file:///workspace'),
            name: 'workspace',
            index: 0
        };
        const loader = new ConfigLoader(validator());

        equal(loader.isConfigFile(vscode.Uri.parse('file:///workspace/.yamlrefs.json'), folder), true);
        equal(loader.isConfigFile(vscode.Uri.parse('file:///workspace/nested/.yamlrefs.json'), folder), false);
    });
});
