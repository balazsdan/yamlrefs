import { deepStrictEqual, equal } from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { JsonDefinitionSource, JsonDefinitionSourceFactory } from '../json';
import type { DefinitionContext } from '../model';
import { textDocument } from './helpers';

function fixtureContext(): DefinitionContext {
    const directory = vscode.Uri.file(path.resolve(
        __dirname,
        '..',
        '..',
        'examples',
        'external-sources'
    ));
    return {
        rootDocument: textDocument('', vscode.Uri.joinPath(directory, 'pages.yaml')),
        configDirectory: directory,
        configUri: vscode.Uri.joinPath(directory, '.yamlrefs.json')
    };
}

suite('JsonDefinitionSourceFactory', () => {
    test('validates source-specific properties', () => {
        const factory = new JsonDefinitionSourceFactory();

        deepStrictEqual(factory.validate({
            type: 'json',
            files: ['settings/*.json'],
            paths: ['/components/*/id']
        }), []);
        deepStrictEqual(factory.validate({
            type: 'json',
            files: ['settings/*.json'],
            paths: [],
            extra: true
        }), [
            'Unknown JSON source property "extra".',
            'JSON source "paths" must be a non-empty array of path glob strings.'
        ]);
    });
});

suite('JsonDefinitionSource', () => {
    test('collects scalar values on matching JSON paths', async () => {
        const source = new JsonDefinitionSource('theme', {
            type: 'json',
            files: ['settings/themes.json'],
            paths: ['/components/*/id']
        });

        const result = await source.collect(fixtureContext());

        deepStrictEqual(result.definitions.map(item => item.value), [
            'light',
            'dark',
            'high-contrast'
        ]);
        equal(result.definitions.every(item => item.origin === 'external'), true);
        deepStrictEqual(result.issues, []);
    });

    test('reports a source error when no files match', async () => {
        const source = new JsonDefinitionSource('theme', {
            type: 'json',
            files: ['settings/does-not-exist-*.json'],
            paths: ['/components/*/id']
        });

        const result = await source.collect(fixtureContext());

        deepStrictEqual(result.definitions, []);
        deepStrictEqual(result.issues.map(issue => issue.code), ['source-error']);
    });
});
