import { deepStrictEqual, equal, match } from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
    IniDefinitionSource,
    IniDefinitionSourceFactory,
    IniDocumentParser
} from '../ini';
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

suite('IniDocumentParser', () => {
    test('parses sections, repeated keys, quotes, comments, and offsets', () => {
        const document = textDocument([
            'global=one',
            '[ Themes ] ; comment',
            '  +Name = "light"  ',
            '+Name=dark',
            '# ignored=value'
        ].join('\r\n'), vscode.Uri.parse('file:///settings.ini'), 'ini');
        const parsed = new IniDocumentParser().parse(document);

        deepStrictEqual(parsed.entries.map(({ section, key, value }) => ({
            section,
            key,
            value
        })), [
            { section: '', key: 'global', value: 'one' },
            { section: 'Themes', key: '+Name', value: 'light' },
            { section: 'Themes', key: '+Name', value: 'dark' }
        ]);
        const quoted = parsed.entries[1];
        equal(document.getText(new vscode.Range(
            document.positionAt(quoted.valueStart),
            document.positionAt(quoted.valueEnd)
        )), 'light');
    });
});

suite('IniDefinitionSourceFactory', () => {
    test('accepts a complete source configuration', () => {
        deepStrictEqual(new IniDefinitionSourceFactory().validate({
            type: 'ini',
            files: ['settings/*.ini'],
            sections: ['Environments'],
            keys: ['+Name'],
            from: 'value',
            pattern: '^(?<value>.+)$'
        }), []);
    });

    test('reports each invalid source option once', () => {
        const problems = new IniDefinitionSourceFactory().validate({
            type: 'ini',
            files: ['settings/*.ini'],
            sections: [],
            keys: [''],
            from: 'other',
            pattern: '[',
            extra: true
        });

        deepStrictEqual(problems.slice(0, 4), [
            'Unknown INI source property "extra".',
            'INI source "sections" must be a non-empty array of glob strings.',
            'INI source "keys" must be a non-empty array of glob strings.',
            'INI source "from" must be either "key" or "value".'
        ]);
        equal(problems.length, 5);
        match(problems[4], /^Invalid INI extraction pattern:/);
    });
});

suite('IniDefinitionSource', () => {
    test('filters entries and extracts the named value group', async () => {
        const source = new IniDefinitionSource('environment', {
            type: 'ini',
            files: ['settings/environments.ini'],
            sections: ['Environments'],
            keys: ['+Name'],
            from: 'value',
            pattern: '^(?<value>prod.*)$'
        });

        const result = await source.collect(fixtureContext());

        deepStrictEqual(result.definitions.map(item => item.value), ['production']);
        equal(result.definitions[0].range.start.line, 3);
        equal(result.definitions[0].range.start.character, 6);
        deepStrictEqual(result.issues, []);
    });
});
