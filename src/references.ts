import * as vscode from 'vscode';

import type { CompiledGlobSet } from './globs';
import { compileGlobSet, toYamlPath } from './globs';
import { DefinitionIndex } from './definitionSources';
import { IncludeGraphResolver } from './includeGraph';
import type {
    DefinitionContext,
    IndexedDefinitions,
    ReferenceOccurrence,
    ResolutionResult,
    SourceIssue,
    ValidationIssue,
    YamlRefsConfig,
    YamlScalarNode,
    YamlScalarStyle
} from './model';
import { YamlDocumentStore } from './yamlDocuments';

interface ReferenceRule {
    readonly definitionName: string;
    readonly paths: CompiledGlobSet;
}

function occurrenceFor(
    document: vscode.TextDocument,
    scalar: YamlScalarNode,
    definitionName: string
): ReferenceOccurrence {
    const range = new vscode.Range(
        document.positionAt(scalar.start),
        document.positionAt(scalar.end)
    );
    const replacementStart = scalar.style === 'plain'
        ? scalar.start
        : Math.min(scalar.start + 1, scalar.end);

    return {
        definitionName,
        path: scalar.path,
        value: scalar.value,
        range,
        replacementRange: new vscode.Range(
            document.positionAt(replacementStart),
            document.positionAt(scalar.end)
        ),
        start: scalar.start,
        end: scalar.end,
        style: scalar.style
    };
}

function issueKey(issue: SourceIssue): string {
    return [
        issue.uri.toString(),
        issue.range?.start.line ?? -1,
        issue.range?.start.character ?? -1,
        issue.message
    ].join(':');
}

export function formatYamlScalar(value: string, style: YamlScalarStyle): string {
    if (style === 'single-quoted') {
        return `'${value.replace(/'/g, "''")}'`;
    }

    if (style === 'double-quoted') {
        return JSON.stringify(value);
    }

    const reserved = /^(?:null|~|true|false|yes|no|on|off)$/i;
    const safePlain = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
    return safePlain.test(value) && !reserved.test(value)
        ? value
        : JSON.stringify(value);
}

export function formatYamlCompletion(
    value: string,
    style: YamlScalarStyle
): string {
    const scalar = formatYamlScalar(value, style);
    return style === 'plain' ? scalar : scalar.slice(1);
}

export class ReferenceScanner {
    private rules: readonly ReferenceRule[] = [];

    constructor(private readonly documents: YamlDocumentStore) {}

    configure(config?: YamlRefsConfig): void {
        if (!config) {
            this.rules = [];
            return;
        }

        const rules: ReferenceRule[] = [];
        for (const [definitionName, definition] of Object.entries(config.definitions)) {
            rules.push({
                definitionName,
                paths: compileGlobSet(definition.references)
            });
        }

        for (const [definitionName, definition] of Object.entries(config.externalDefinitions)) {
            rules.push({
                definitionName,
                paths: compileGlobSet(definition.references)
            });
        }

        this.rules = rules;
    }

    scan(document: vscode.TextDocument): readonly ReferenceOccurrence[] {
        const parsed = this.documents.get(document);
        const occurrences: ReferenceOccurrence[] = [];

        for (const scalar of parsed.scalars) {
            const yamlPath = toYamlPath(scalar.path);
            for (const rule of this.rules) {
                if (rule.paths.matches(yamlPath)) {
                    occurrences.push(occurrenceFor(document, scalar, rule.definitionName));
                }
            }
        }

        return occurrences;
    }

    findAt(
        document: vscode.TextDocument,
        position: vscode.Position
    ): readonly ReferenceOccurrence[] {
        const offset = document.offsetAt(position);
        const candidates = this.scan(document).filter(occurrence =>
            offset >= occurrence.start && offset <= occurrence.end);

        if (candidates.length === 0) {
            return [];
        }

        const deepest = Math.max(...candidates.map(candidate => candidate.path.length));
        return candidates.filter(candidate => candidate.path.length === deepest);
    }
}

export class ReferenceResolver {
    constructor(private readonly index: DefinitionIndex) {}

    candidates(
        occurrence: ReferenceOccurrence,
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<IndexedDefinitions> {
        return this.index.get(occurrence.definitionName, context, token);
    }

    async resolve(
        occurrence: ReferenceOccurrence,
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<ResolutionResult> {
        const indexed = await this.index.get(occurrence.definitionName, context, token);
        return {
            matches: occurrence.value === undefined
                ? []
                : indexed.byValue.get(occurrence.value) ?? [],
            indexed
        };
    }
}

export class ReferenceValidator {
    constructor(
        private readonly scanner: ReferenceScanner,
        private readonly resolver: ReferenceResolver,
        private readonly includes: IncludeGraphResolver
    ) {}

    async validate(
        document: vscode.TextDocument,
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<readonly ValidationIssue[]> {
        const issues: ValidationIssue[] = [];
        const seenIssues = new Set<string>();
        const seenSourceIssues = new Set<string>();
        const graph = await this.includes.resolve(document, token);

        for (const issue of graph.issues) {
            if (issue.uri.toString() !== document.uri.toString()) {
                continue;
            }

            this.addIssue(issues, seenIssues, {
                ...issue,
                code: issue.code ?? 'invalid-include'
            });
        }

        const occurrences = this.scanner.scan(document);
        const resolutions = await Promise.all(occurrences.map(async occurrence => ({
            occurrence,
            result: await this.resolver.resolve(occurrence, context, token)
        })));

        for (const { occurrence, result } of resolutions) {
            let sourceFailed = false;

            for (const sourceIssue of result.indexed.issues) {
                if (sourceIssue.severity === vscode.DiagnosticSeverity.Error) {
                    sourceFailed = true;
                }

                const sourceKey = `${occurrence.definitionName}:${issueKey(sourceIssue)}`;
                if (seenSourceIssues.has(sourceKey)) {
                    continue;
                }
                seenSourceIssues.add(sourceKey);

                const localIssue: ValidationIssue = sourceIssue.uri.toString() === document.uri.toString()
                    ? {
                        ...sourceIssue,
                        range: sourceIssue.range ?? occurrence.range,
                        code: sourceIssue.code ?? 'source-error'
                    }
                    : {
                        uri: document.uri,
                        range: occurrence.range,
                        message: `Definition source "${occurrence.definitionName}": ${sourceIssue.message}`,
                        severity: sourceIssue.severity,
                        code: sourceIssue.code ?? 'source-error'
                    };

                this.addIssue(issues, seenIssues, localIssue);
            }

            if (occurrence.value === undefined || occurrence.value === '' || sourceFailed) {
                continue;
            }

            if (result.matches.length === 0) {
                this.addIssue(issues, seenIssues, {
                    uri: document.uri,
                    range: occurrence.range,
                    message: `Unknown ${occurrence.definitionName} reference "${occurrence.value}".`,
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'unknown-reference'
                });
            }
        }

        return issues;
    }

    private addIssue(
        output: ValidationIssue[],
        seen: Set<string>,
        issue: ValidationIssue
    ): void {
        const key = issueKey(issue);
        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        output.push(issue);
    }
}
