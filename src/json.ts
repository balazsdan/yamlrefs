import * as vscode from 'vscode';

import type {
    DefinitionCollection,
    DefinitionContext,
    DefinitionRecord,
    ExternalSourceConfig,
    SourceIssue
} from './model';
import {
    compileGlobSet,
    findWorkspaceFiles,
    toYamlPath,
    validateGlob
} from './globs';
import type {
    DefinitionSource,
    ExternalDefinitionSourceFactory
} from './definitionSources';
import { YamlDocumentParser } from './yamlDocuments';

interface JsonSourceConfig extends ExternalSourceConfig {
    readonly type: 'json';
    readonly paths: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
    return Array.isArray(value)
        && value.length > 0
        && value.every(item => typeof item === 'string' && item.trim() !== '');
}

function documentRange(document: vscode.TextDocument): vscode.Range {
    const lastLine = Math.max(0, document.lineCount - 1);
    return new vscode.Range(new vscode.Position(0, 0), document.lineAt(lastLine).range.end);
}

function parseErrorRange(document: vscode.TextDocument, error: unknown): vscode.Range {
    const message = error instanceof Error ? error.message : String(error);
    const match = /position\s+(\d+)/i.exec(message);
    if (!match) {
        return documentRange(document);
    }

    const offset = Math.min(Number(match[1]), document.getText().length);
    return new vscode.Range(
        document.positionAt(offset),
        document.positionAt(Math.min(offset + 1, document.getText().length))
    );
}

export class JsonDefinitionSource implements DefinitionSource {
    private readonly paths;
    private readonly parser = new YamlDocumentParser();

    constructor(
        private readonly definitionName: string,
        private readonly config: JsonSourceConfig
    ) {
        this.paths = compileGlobSet(config.paths);
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
                    message: `JSON file could not be opened: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'source-error'
                });
                continue;
            }

            try {
                JSON.parse(document.getText());
            } catch (error) {
                issues.push({
                    uri,
                    range: parseErrorRange(document, error),
                    message: `Invalid JSON: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'source-error'
                });
                continue;
            }

            const parsed = this.parser.parse(document);
            for (const scalar of parsed.scalars) {
                if (scalar.value === undefined || !this.paths.matches(toYamlPath(scalar.path))) {
                    continue;
                }

                definitions.push({
                    definitionName: this.definitionName,
                    value: scalar.value,
                    uri,
                    range: new vscode.Range(
                        document.positionAt(scalar.start),
                        document.positionAt(scalar.end)
                    ),
                    origin: 'external'
                });
            }
        }

        return { definitions, issues, dependencies };
    }
}

export class JsonDefinitionSourceFactory implements ExternalDefinitionSourceFactory {
    readonly type = 'json';

    validate(config: ExternalSourceConfig): readonly string[] {
        const problems: string[] = [];

        if (!isRecord(config)) {
            return ['The JSON source must be an object.'];
        }

        const allowed = new Set(['type', 'files', 'paths']);
        for (const key of Object.keys(config)) {
            if (!allowed.has(key)) {
                problems.push(`Unknown JSON source property "${key}".`);
            }
        }

        if (!isNonEmptyStringArray(config.paths)) {
            problems.push('JSON source "paths" must be a non-empty array of path glob strings.');
        } else {
            for (const pattern of config.paths) {
                const problem = validateGlob(pattern);
                if (problem) {
                    problems.push(`Invalid JSON path glob "${pattern}": ${problem}`);
                }
            }
        }

        return problems;
    }

    create(
        definitionName: string,
        config: ExternalSourceConfig
    ): DefinitionSource {
        return new JsonDefinitionSource(
            definitionName,
            config as JsonSourceConfig
        );
    }
}
