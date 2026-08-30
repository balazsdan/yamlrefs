import * as vscode from 'vscode';

import type {
    DefinitionRecord,
    ReferenceOccurrence,
    SourceIssue
} from './model';
import { formatYamlCompletion } from './references';
import { WorkspaceSession } from './workspaceSession';

export interface WorkspaceSessionLookup {
    sessionFor(uri: vscode.Uri): WorkspaceSession | undefined;
}

function locationKey(definition: DefinitionRecord): string {
    return [
        definition.uri.toString(),
        definition.range.start.line,
        definition.range.start.character,
        definition.range.end.line,
        definition.range.end.character
    ].join(':');
}

function diagnosticFor(issue: SourceIssue): vscode.Diagnostic {
    const position = new vscode.Position(0, 0);
    const diagnostic = new vscode.Diagnostic(
        issue.range ?? new vscode.Range(position, position),
        issue.message,
        issue.severity
    );
    diagnostic.source = 'yamlrefs';
    diagnostic.code = issue.code;
    return diagnostic;
}

export class ReferenceCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly sessions: WorkspaceSessionLookup) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[]> {
        const session = this.sessions.sessionFor(document.uri);
        if (!session) {
            return [];
        }

        const occurrences = session.findReferencesAt(document, position);
        if (occurrences.length === 0) {
            return [];
        }

        const candidateSets = await Promise.all(occurrences.map(async occurrence => ({
            occurrence,
            indexed: await session.candidates(document, occurrence, token)
        })));

        const byValue = new Map<string, {
            readonly occurrence: ReferenceOccurrence;
            readonly definitions: DefinitionRecord[];
            readonly names: Set<string>;
        }>();

        for (const { occurrence, indexed } of candidateSets) {
            for (const definition of indexed.definitions) {
                let entry = byValue.get(definition.value);
                if (!entry) {
                    entry = {
                        occurrence,
                        definitions: [],
                        names: new Set()
                    };
                    byValue.set(definition.value, entry);
                }

                entry.definitions.push(definition);
                entry.names.add(occurrence.definitionName);
            }
        }

        return [...byValue.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([value, entry]) => {
                const item = new vscode.CompletionItem(
                    value,
                    vscode.CompletionItemKind.Reference
                );
                const names = [...entry.names].join(', ');
                const origins = new Set(entry.definitions.map(definition => definition.origin));
                item.detail = `${names} reference · ${[...origins].join(' + ')}`;
                item.filterText = value;
                item.sortText = value;
                item.textEdit = new vscode.TextEdit(
                    entry.occurrence.replacementRange,
                    formatYamlCompletion(value, entry.occurrence.style)
                );

                const locations = entry.definitions
                    .slice(0, 5)
                    .map(definition => vscode.workspace.asRelativePath(definition.uri, false));
                if (locations.length > 0) {
                    item.documentation = new vscode.MarkdownString(
                        `Defined in ${locations.map(location => `\`${location}\``).join(', ')}`
                    );
                }

                return item;
            });
    }
}

export class ReferenceDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly sessions: WorkspaceSessionLookup) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const session = this.sessions.sessionFor(document.uri);
        if (!session) {
            return [];
        }

        const occurrences = session.findReferencesAt(document, position)
            .filter(occurrence => occurrence.value !== undefined && occurrence.value !== '');
        const results = await Promise.all(occurrences.map(occurrence =>
            session.resolve(document, occurrence, token)));
        const locations = new Map<string, vscode.Location>();

        for (const result of results) {
            for (const definition of result.matches) {
                locations.set(
                    locationKey(definition),
                    new vscode.Location(definition.uri, definition.range)
                );
            }
        }

        return [...locations.values()];
    }
}

function sourceDescription(definition: DefinitionRecord): string {
    if (definition.origin === 'internal') {
        return 'internal YAML';
    }

    const extension = /\.([^./]+)$/.exec(definition.uri.path)?.[1];
    return extension ? `external ${extension.toUpperCase()}` : 'external';
}

function sourceLocation(definition: DefinitionRecord): string {
    const relativePath = vscode.workspace.asRelativePath(definition.uri, false);
    return `${relativePath}:${definition.range.start.line + 1}`;
}

export class ReferenceHoverProvider implements vscode.HoverProvider {
    constructor(private readonly sessions: WorkspaceSessionLookup) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const session = this.sessions.sessionFor(document.uri);
        if (!session) {
            return undefined;
        }

        const occurrences = session.findReferencesAt(document, position)
            .filter(occurrence => occurrence.value !== undefined && occurrence.value !== '');
        if (occurrences.length === 0) {
            return undefined;
        }

        const resolutions = await Promise.all(occurrences.map(async occurrence => ({
            occurrence,
            result: await session.resolve(document, occurrence, token)
        })));
        const contents = new vscode.MarkdownString(undefined, true);

        resolutions.forEach(({ occurrence, result }, index) => {
            if (index > 0) {
                contents.appendMarkdown('\n\n---\n\n');
            }

            contents.appendMarkdown('$(references) **');
            contents.appendText(`${occurrence.definitionName} reference`);
            contents.appendMarkdown('**\n\n**Value:** ');
            contents.appendText(occurrence.value ?? '');

            const definitions = new Map<string, DefinitionRecord>();
            for (const definition of result.matches) {
                definitions.set(locationKey(definition), definition);
            }

            if (definitions.size === 0) {
                contents.appendMarkdown('\n\n$(warning) No matching definition was found.');
                return;
            }

            contents.appendMarkdown(definitions.size === 1
                ? '\n\n**Defined in:**'
                : '\n\n**Defined in multiple locations:**');

            for (const definition of definitions.values()) {
                contents.appendMarkdown('\n\n- $(file) ');
                contents.appendText(sourceLocation(definition));
                contents.appendMarkdown(' — ');
                contents.appendText(sourceDescription(definition));
            }
        });

        return new vscode.Hover(contents, occurrences[0].range);
    }
}

export class IncludeDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly sessions: WorkspaceSessionLookup) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location | undefined> {
        const session = this.sessions.sessionFor(document.uri);
        if (!session) {
            return undefined;
        }

        const target = await session.includeTargetAt(document, position, token);
        if (!target) {
            return undefined;
        }

        return new vscode.Location(target, new vscode.Position(0, 0));
    }
}

export class DiagnosticsController implements vscode.Disposable {
    private timer: NodeJS.Timeout | undefined;
    private generation = 0;

    constructor(
        private readonly collection: vscode.DiagnosticCollection,
        private readonly sessions: WorkspaceSessionLookup
    ) {}

    publishConfigIssues(session: WorkspaceSession): void {
        if (session.issues.length === 0) {
            this.collection.delete(session.configUri);
            return;
        }

        this.collection.set(
            session.configUri,
            session.issues.map(diagnosticFor)
        );
    }

    schedule(delay = 150): void {
        this.generation += 1;
        const requestedGeneration = this.generation;

        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.validateOpenDocuments(requestedGeneration);
        }, delay);
    }

    async validateOpenDocuments(requestedGeneration = this.generation): Promise<void> {
        const documents = vscode.workspace.textDocuments.filter(document =>
            document.languageId === 'yaml');

        await Promise.all(documents.map(document =>
            this.validateNow(document, requestedGeneration)));
    }

    clear(uri: vscode.Uri): void {
        this.collection.delete(uri);
    }

    dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }

    private async validateNow(
        document: vscode.TextDocument,
        requestedGeneration: number
    ): Promise<void> {
        const session = this.sessions.sessionFor(document.uri);
        if (!session) {
            this.collection.delete(document.uri);
            return;
        }

        try {
            const issues = await session.validate(document);
            if (requestedGeneration !== this.generation) {
                return;
            }

            this.collection.set(document.uri, issues.map(diagnosticFor));
        } catch (error) {
            if (error instanceof vscode.CancellationError
                || requestedGeneration !== this.generation) {
                return;
            }

            const position = new vscode.Position(0, 0);
            this.collection.set(document.uri, [diagnosticFor({
                uri: document.uri,
                range: new vscode.Range(position, position),
                message: `Reference validation failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                severity: vscode.DiagnosticSeverity.Error,
                code: 'source-error'
            })]);
        }
    }
}
