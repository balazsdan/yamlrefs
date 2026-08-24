import * as vscode from 'vscode';

import type {
    DefinitionCollection,
    DefinitionContext,
    DefinitionRecord,
    ExternalSourceConfig,
    IniEntry,
    ParsedIniDocument,
    SourceIssue
} from './model';
import {
    compileGlobSet,
    findWorkspaceFiles,
    validateGlob
} from './globs';
import type {
    DefinitionSource,
    ExternalDefinitionSourceFactory
} from './definitionSources';

interface IniSourceConfig extends ExternalSourceConfig {
    readonly type: 'ini';
    readonly sections: readonly string[];
    readonly keys: readonly string[];
    readonly from: 'key' | 'value';
    readonly pattern?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
    return Array.isArray(value)
        && value.length > 0
        && value.every(item => typeof item === 'string' && item.trim() !== '');
}

export class IniDocumentParser {
    parse(document: vscode.TextDocument): ParsedIniDocument {
        const text = document.getText();
        const entries: IniEntry[] = [];
        const issues: SourceIssue[] = [];
        let section = '';
        let lineStart = 0;

        while (lineStart <= text.length) {
            const lineFeed = text.indexOf('\n', lineStart);
            const nextLine = lineFeed === -1 ? text.length : lineFeed + 1;
            const rawEnd = lineFeed === -1 ? text.length : lineFeed;
            const lineEnd = rawEnd > lineStart && text[rawEnd - 1] === '\r'
                ? rawEnd - 1
                : rawEnd;
            const line = text.slice(lineStart, lineEnd);
            const trimmed = line.trim();

            if (trimmed !== '' && !trimmed.startsWith(';') && !trimmed.startsWith('#')) {
                const sectionMatch = /^\s*\[([^\]]+)]\s*(?:[;#].*)?$/.exec(line);
                if (sectionMatch) {
                    section = sectionMatch[1].trim();
                } else {
                    const equals = line.indexOf('=');
                    if (equals >= 0) {
                        const rawKey = line.slice(0, equals);
                        const key = rawKey.trim();

                        if (key !== '') {
                            const keyLeading = rawKey.length - rawKey.trimStart().length;
                            const keyStart = lineStart + keyLeading;
                            const keyEnd = keyStart + key.length;
                            const rawValue = line.slice(equals + 1);
                            const leading = rawValue.length - rawValue.trimStart().length;
                            const trailing = rawValue.length - rawValue.trimEnd().length;
                            let valueStart = lineStart + equals + 1 + leading;
                            let valueEnd = lineStart + line.length - trailing;
                            let value = text.slice(valueStart, valueEnd);

                            if (value.length >= 2) {
                                const first = value[0];
                                const last = value[value.length - 1];
                                if ((first === '"' && last === '"')
                                    || (first === "'" && last === "'")) {
                                    valueStart += 1;
                                    valueEnd -= 1;
                                    value = text.slice(valueStart, valueEnd);
                                }
                            }

                            entries.push({
                                section,
                                key,
                                value,
                                keyStart,
                                keyEnd,
                                valueStart,
                                valueEnd
                            });
                        }
                    }
                }
            }

            if (lineFeed === -1) {
                break;
            }
            lineStart = nextLine;
        }

        return {
            uri: document.uri,
            document,
            entries,
            issues
        };
    }
}

export class IniDefinitionSource implements DefinitionSource {
    private readonly sectionPatterns;
    private readonly keyPatterns;
    private readonly extractionPattern?: RegExp;
    private readonly parser = new IniDocumentParser();

    constructor(
        private readonly definitionName: string,
        private readonly config: IniSourceConfig
    ) {
        this.sectionPatterns = compileGlobSet(config.sections);
        this.keyPatterns = compileGlobSet(config.keys);
        this.extractionPattern = config.pattern
            ? new RegExp(config.pattern)
            : undefined;
    }

    async collect(
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<DefinitionCollection> {
        const definitions: DefinitionRecord[] = [];
        const issues: SourceIssue[] = [];
        const dependencies: vscode.Uri[] = [];
        const files = await findWorkspaceFiles(
            context.configDirectory,
            this.config.files,
            token
        );

        if (files.length === 0) {
            issues.push({
                uri: context.configUri,
                message: `External definition "${this.definitionName}" did not match any files.`,
                severity: vscode.DiagnosticSeverity.Error,
                code: 'source-error'
            });
        }

        for (const uri of files) {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            dependencies.push(uri);

            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(uri);
            } catch (error) {
                issues.push({
                    uri,
                    message: `INI file could not be opened: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'source-error'
                });
                continue;
            }

            const parsed = this.parser.parse(document);
            issues.push(...parsed.issues);

            for (const entry of parsed.entries) {
                if (!this.sectionPatterns.matches(entry.section)
                    || !this.keyPatterns.matches(entry.key)) {
                    continue;
                }

                const extracted = this.extract(entry);
                if (!extracted || extracted.value === '') {
                    continue;
                }

                definitions.push({
                    definitionName: this.definitionName,
                    value: extracted.value,
                    uri,
                    range: new vscode.Range(
                        document.positionAt(extracted.start),
                        document.positionAt(extracted.end)
                    ),
                    origin: 'external'
                });
            }
        }

        return { definitions, issues, dependencies };
    }

    private extract(entry: IniEntry): {
        readonly value: string;
        readonly start: number;
        readonly end: number;
    } | undefined {
        const selected = this.config.from === 'key' ? entry.key : entry.value;
        const selectedStart = this.config.from === 'key' ? entry.keyStart : entry.valueStart;

        if (!this.extractionPattern) {
            return {
                value: selected,
                start: selectedStart,
                end: selectedStart + selected.length
            };
        }

        this.extractionPattern.lastIndex = 0;
        const match = this.extractionPattern.exec(selected);
        if (!match) {
            return undefined;
        }

        const value = match.groups?.value ?? match[1] ?? match[0];
        const withinMatch = match[0].indexOf(value);
        const relativeStart = match.index + Math.max(0, withinMatch);

        return {
            value,
            start: selectedStart + relativeStart,
            end: selectedStart + relativeStart + value.length
        };
    }
}

export class IniDefinitionSourceFactory implements ExternalDefinitionSourceFactory {
    readonly type = 'ini';

    validate(config: ExternalSourceConfig): readonly string[] {
        const problems: string[] = [];

        if (!isRecord(config)) {
            return ['The INI source must be an object.'];
        }

        const allowed = new Set(['type', 'files', 'sections', 'keys', 'from', 'pattern']);
        for (const key of Object.keys(config)) {
            if (!allowed.has(key)) {
                problems.push(`Unknown INI source property "${key}".`);
            }
        }

        if (!isNonEmptyStringArray(config.sections)) {
            problems.push('INI source "sections" must be a non-empty array of glob strings.');
        } else {
            for (const pattern of config.sections) {
                const problem = validateGlob(pattern);
                if (problem) {
                    problems.push(`Invalid INI section glob "${pattern}": ${problem}`);
                }
            }
        }

        if (!isNonEmptyStringArray(config.keys)) {
            problems.push('INI source "keys" must be a non-empty array of glob strings.');
        } else {
            for (const pattern of config.keys) {
                const problem = validateGlob(pattern);
                if (problem) {
                    problems.push(`Invalid INI key glob "${pattern}": ${problem}`);
                }
            }
        }

        if (config.from !== 'key' && config.from !== 'value') {
            problems.push('INI source "from" must be either "key" or "value".');
        }

        if (config.pattern !== undefined && typeof config.pattern !== 'string') {
            problems.push('INI source "pattern" must be a regular-expression string.');
        } else if (typeof config.pattern === 'string') {
            try {
                new RegExp(config.pattern);
            } catch (error) {
                problems.push(`Invalid INI extraction pattern: ${
                    error instanceof Error ? error.message : String(error)
                }`);
            }
        }

        return problems;
    }

    create(
        definitionName: string,
        config: ExternalSourceConfig
    ): DefinitionSource {
        return new IniDefinitionSource(
            definitionName,
            config as IniSourceConfig
        );
    }
}
