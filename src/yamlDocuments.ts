import * as vscode from 'vscode';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

import type {
    IncludeEntry,
    ParsedYamlDocument,
    SourceIssue,
    YamlScalarNode,
    YamlScalarStyle
} from './model';

function offsetsFor(node: unknown): readonly [number, number] | undefined {
    if (!node || typeof node !== 'object' || !('range' in node)) {
        return undefined;
    }

    const range = (node as { range?: readonly number[] }).range;
    if (!range || range.length < 2) {
        return undefined;
    }

    return [range[0], range[1]];
}

function styleFor(node: unknown): YamlScalarStyle {
    const type = node && typeof node === 'object' && 'type' in node
        ? String((node as { type?: unknown }).type)
        : '';

    if (type === 'QUOTE_SINGLE') {
        return 'single-quoted';
    }

    if (type === 'QUOTE_DOUBLE') {
        return 'double-quoted';
    }

    return 'plain';
}

function rangeFromOffsets(
    document: vscode.TextDocument,
    start: number,
    end: number
): vscode.Range {
    return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

export class YamlDocumentParser {
    parse(document: vscode.TextDocument): ParsedYamlDocument {
        const parsed = parseDocument(document.getText(), {
            prettyErrors: false,
            uniqueKeys: false
        });
        const scalars: YamlScalarNode[] = [];
        const includes: IncludeEntry[] = [];
        const issues: SourceIssue[] = [];

        this.walk(parsed.contents, [], scalars);
        this.readIncludes(document, parsed.contents, includes, issues);

        return {
            uri: document.uri,
            document,
            scalars,
            includes,
            issues
        };
    }

    private walk(
        node: unknown,
        path: readonly string[],
        output: YamlScalarNode[]
    ): void {
        if (!node) {
            return;
        }

        if (isMap(node)) {
            for (const pair of node.items) {
                if (!isScalar(pair.key)) {
                    continue;
                }

                const key = String(pair.key.value);
                this.walk(pair.value, [...path, key], output);
            }
            return;
        }

        if (isSeq(node)) {
            node.items.forEach((item, index) => {
                this.walk(item, [...path, String(index)], output);
            });
            return;
        }

        if (!isScalar(node)) {
            return;
        }

        const offsets = offsetsFor(node);
        if (!offsets) {
            return;
        }

        output.push({
            path: [...path],
            value: node.value === null || node.value === undefined
                ? undefined
                : String(node.value),
            start: offsets[0],
            end: offsets[1],
            style: styleFor(node)
        });
    }

    private readIncludes(
        document: vscode.TextDocument,
        root: unknown,
        output: IncludeEntry[],
        issues: SourceIssue[]
    ): void {
        if (!isMap(root)) {
            return;
        }

        const includePairs = root.items.filter(pair =>
            isScalar(pair.key) && String(pair.key.value) === '$include');

        if (includePairs.length > 1) {
            for (const pair of includePairs.slice(1)) {
                const offsets = offsetsFor(pair.key) ?? [0, 0];
                issues.push({
                    uri: document.uri,
                    range: rangeFromOffsets(document, offsets[0], offsets[1]),
                    message: 'Only one root-level "$include" key is allowed; put every include in its list.',
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'invalid-include'
                });
            }
        }

        const includePair = includePairs[0];
        if (!includePair) {
            return;
        }

        if (!isSeq(includePair.value)) {
            const offsets = offsetsFor(includePair.value)
                ?? offsetsFor(includePair.key)
                ?? [0, 0];
            issues.push({
                uri: document.uri,
                range: rangeFromOffsets(document, offsets[0], offsets[1]),
                message: '"$include" must be a list of YAML file paths, even when it contains one file.',
                severity: vscode.DiagnosticSeverity.Error,
                code: 'invalid-include'
            });
            return;
        }

        for (const item of includePair.value.items) {
            const offsets = offsetsFor(item) ?? offsetsFor(includePair.value) ?? [0, 0];
            if (!isScalar(item) || typeof item.value !== 'string' || item.value.trim() === '') {
                issues.push({
                    uri: document.uri,
                    range: rangeFromOffsets(document, offsets[0], offsets[1]),
                    message: 'Every "$include" list item must be a non-empty YAML file path.',
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'invalid-include'
                });
                continue;
            }

            output.push({
                rawPath: item.value,
                start: offsets[0],
                end: offsets[1]
            });
        }
    }
}

export class YamlDocumentStore {
    private readonly cache = new Map<string, {
        readonly version: number;
        readonly parsed: ParsedYamlDocument;
    }>();

    constructor(private readonly parser: YamlDocumentParser) {}

    get(document: vscode.TextDocument): ParsedYamlDocument {
        const key = document.uri.toString();
        const cached = this.cache.get(key);

        if (cached?.version === document.version) {
            return cached.parsed;
        }

        const parsed = this.parser.parse(document);
        this.cache.set(key, { version: document.version, parsed });
        return parsed;
    }

    async open(
        uri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<ParsedYamlDocument> {
        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const document = await vscode.workspace.openTextDocument(uri);
        return this.get(document);
    }

    invalidate(uri: vscode.Uri): void {
        this.cache.delete(uri.toString());
    }

    clear(): void {
        this.cache.clear();
    }
}
