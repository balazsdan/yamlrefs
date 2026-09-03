import * as vscode from 'vscode';

import { ExternalSourceRegistry } from './definitionSources';
import { validateGlob } from './globs';
import { DEFAULT_INCLUDE_KEY } from './model';
import type {
    ConfigIssue,
    ConfigLoadResult,
    ExternalDefinitionConfig,
    ExternalSourceConfig,
    InternalDefinitionConfig,
    YamlRefsConfig
} from './model';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const start = document.positionAt(offset);
    const end = document.positionAt(Math.min(offset + 1, document.getText().length));
    return new vscode.Range(start, end);
}

function stringArray(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value)
        || value.length === 0
        || !value.every(item => typeof item === 'string' && item.trim() !== '')) {
        return undefined;
    }

    return [...value];
}

function unknownProperties(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    describe: (key: string) => string,
    problems: string[]
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            problems.push(describe(key));
        }
    }
}

export class ConfigValidator {
    constructor(private readonly externalSources: ExternalSourceRegistry) {}

    validate(raw: unknown): {
        readonly config?: YamlRefsConfig;
        readonly problems: readonly string[];
    } {
        const problems: string[] = [];
        if (!isRecord(raw)) {
            return { problems: ['The configuration root must be a JSON object.'] };
        }

        unknownProperties(
            raw,
            new Set(['version', 'includeKey', 'definitions', 'externalDefinitions']),
            key => `Unknown configuration property "${key}".`,
            problems
        );

        if (raw.version !== 1) {
            problems.push('Configuration "version" must be 1.');
        }

        const includeKeyValue = raw.includeKey === undefined
            ? DEFAULT_INCLUDE_KEY
            : raw.includeKey;
        let includeKey = DEFAULT_INCLUDE_KEY;
        if (typeof includeKeyValue !== 'string' || includeKeyValue.trim() === '') {
            problems.push('Configuration "includeKey" must be a non-empty string.');
        } else {
            includeKey = includeKeyValue;
        }

        const definitionsValue = raw.definitions ?? {};
        const externalDefinitionsValue = raw.externalDefinitions ?? {};

        if (!isRecord(definitionsValue)) {
            problems.push('"definitions" must be an object keyed by definition name.');
        }

        if (!isRecord(externalDefinitionsValue)) {
            problems.push('"externalDefinitions" must be an object keyed by definition name.');
        }

        const definitions: Record<string, InternalDefinitionConfig> = {};
        const externalDefinitions: Record<string, ExternalDefinitionConfig> = {};

        if (isRecord(definitionsValue)) {
            for (const [name, value] of Object.entries(definitionsValue)) {
                this.validateInternalDefinition(name, value, definitions, problems);
            }
        }

        if (isRecord(externalDefinitionsValue)) {
            for (const [name, value] of Object.entries(externalDefinitionsValue)) {
                if (Object.hasOwn(definitions, name)) {
                    problems.push(`Definition name "${name}" is used by both internal and external definitions.`);
                }
                this.validateExternalDefinition(name, value, externalDefinitions, problems);
            }
        }

        if (problems.length > 0) {
            return { problems };
        }

        return {
            config: {
                version: 1,
                includeKey,
                definitions,
                externalDefinitions
            },
            problems
        };
    }

    private validateInternalDefinition(
        name: string,
        value: unknown,
        output: Record<string, InternalDefinitionConfig>,
        problems: string[]
    ): void {
        if (name.trim() === '') {
            problems.push('Internal definition names must not be empty.');
            return;
        }

        if (!isRecord(value)) {
            problems.push(`Internal definition "${name}" must be an object.`);
            return;
        }

        unknownProperties(
            value,
            new Set(['paths', 'references']),
            key => `Unknown property "${key}" on internal definition "${name}".`,
            problems
        );

        const paths = stringArray(value.paths);
        const references = stringArray(value.references);

        if (!paths) {
            problems.push(`Internal definition "${name}" requires a non-empty "paths" array.`);
        } else {
            this.validateGlobs(paths, `definition path for "${name}"`, problems);
        }

        if (!references) {
            problems.push(`Internal definition "${name}" requires a non-empty "references" array.`);
        } else {
            this.validateGlobs(references, `reference path for "${name}"`, problems);
        }

        if (paths && references) {
            output[name] = { paths, references };
        }
    }

    private validateExternalDefinition(
        name: string,
        value: unknown,
        output: Record<string, ExternalDefinitionConfig>,
        problems: string[]
    ): void {
        if (name.trim() === '') {
            problems.push('External definition names must not be empty.');
            return;
        }

        if (!isRecord(value)) {
            problems.push(`External definition "${name}" must be an object.`);
            return;
        }

        unknownProperties(
            value,
            new Set(['references', 'source']),
            key => `Unknown property "${key}" on external definition "${name}".`,
            problems
        );

        const references = stringArray(value.references);
        if (!references) {
            problems.push(`External definition "${name}" requires a non-empty "references" array.`);
        } else {
            this.validateGlobs(references, `reference path for "${name}"`, problems);
        }

        if (!isRecord(value.source)) {
            problems.push(`External definition "${name}" requires a "source" object.`);
            return;
        }

        const type = value.source.type;
        const files = stringArray(value.source.files);

        if (typeof type !== 'string' || type.trim() === '') {
            problems.push(`External definition "${name}" source requires a non-empty "type".`);
        }

        if (!files) {
            problems.push(`External definition "${name}" source requires a non-empty "files" array.`);
        } else {
            this.validateGlobs(files, `file glob for external definition "${name}"`, problems);
        }

        if (typeof type !== 'string' || type.trim() === '' || !files || !references) {
            return;
        }

        const source: ExternalSourceConfig = {
            ...value.source,
            type,
            files
        };

        for (const problem of this.externalSources.validate(source)) {
            problems.push(`External definition "${name}": ${problem}`);
        }

        output[name] = { references, source };
    }

    private validateGlobs(
        patterns: readonly string[],
        description: string,
        problems: string[]
    ): void {
        for (const pattern of patterns) {
            const problem = validateGlob(pattern);
            if (problem) {
                problems.push(`Invalid ${description} "${pattern}": ${problem}`);
            }
        }
    }
}

export class ConfigLoader {
    constructor(private readonly validator: ConfigValidator) {}

    async load(folder: vscode.WorkspaceFolder): Promise<ConfigLoadResult> {
        const configUri = vscode.Uri.joinPath(folder.uri, '.yamlrefs.json');

        try {
            await vscode.workspace.fs.stat(configUri);
        } catch {
            return {
                configUri,
                configDirectory: folder.uri,
                issues: []
            };
        }

        const document = await vscode.workspace.openTextDocument(configUri);
        let raw: unknown;

        try {
            raw = JSON.parse(document.getText()) as unknown;
        } catch (error) {
            return {
                configUri,
                configDirectory: folder.uri,
                issues: [{
                    uri: configUri,
                    range: parseErrorRange(document, error),
                    message: `Invalid .yamlrefs.json: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    severity: vscode.DiagnosticSeverity.Error
                }]
            };
        }

        const validation = this.validator.validate(raw);
        const range = documentRange(document);
        const issues: ConfigIssue[] = validation.problems.map(message => ({
            uri: configUri,
            range,
            message,
            severity: vscode.DiagnosticSeverity.Error
        }));

        return {
            configUri,
            configDirectory: folder.uri,
            config: validation.config,
            issues
        };
    }

    isConfigFile(uri: vscode.Uri, folder: vscode.WorkspaceFolder): boolean {
        return uri.toString() === vscode.Uri.joinPath(folder.uri, '.yamlrefs.json').toString();
    }
}
