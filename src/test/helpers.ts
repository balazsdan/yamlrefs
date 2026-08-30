import * as vscode from 'vscode';

import type {
    DefinitionContext,
    DefinitionRecord,
    ReferenceOccurrence
} from '../model';

export function textDocument(
    text: string,
    uri = vscode.Uri.parse('file:///workspace/test.yaml'),
    languageId = 'yaml',
    version = 1
): vscode.TextDocument {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '\n') {
            starts.push(index + 1);
        }
    }

    const offsetAt = (position: vscode.Position): number => {
        const line = Math.min(position.line, starts.length - 1);
        return Math.min(starts[line] + position.character, text.length);
    };
    const positionAt = (rawOffset: number): vscode.Position => {
        const offset = Math.max(0, Math.min(rawOffset, text.length));
        let line = starts.length - 1;
        while (starts[line] > offset) {
            line -= 1;
        }
        return new vscode.Position(line, offset - starts[line]);
    };

    return {
        uri,
        languageId,
        version,
        lineCount: starts.length,
        getText: (range?: vscode.Range) => range
            ? text.slice(offsetAt(range.start), offsetAt(range.end))
            : text,
        offsetAt,
        positionAt
    } as vscode.TextDocument;
}

export function context(document: vscode.TextDocument): DefinitionContext {
    const configDirectory = vscode.Uri.joinPath(document.uri, '..');
    return {
        rootDocument: document,
        configDirectory,
        configUri: vscode.Uri.joinPath(configDirectory, '.yamlrefs.json')
    };
}

export function definition(
    value: string,
    document: vscode.TextDocument,
    origin: 'internal' | 'external' = 'internal'
): DefinitionRecord {
    return {
        definitionName: 'item',
        value,
        uri: document.uri,
        range: new vscode.Range(document.positionAt(0), document.positionAt(value.length)),
        origin
    };
}

export function occurrence(
    document: vscode.TextDocument,
    value: string | undefined = 'known'
): ReferenceOccurrence {
    const range = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );
    return {
        definitionName: 'item',
        path: ['item'],
        value,
        range,
        replacementRange: range,
        start: 0,
        end: document.getText().length,
        style: 'plain'
    };
}
