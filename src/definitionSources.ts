import * as vscode from 'vscode';

import { compileGlobSet, toYamlPath } from './globs';
import { IncludeGraphResolver } from './includeGraph';
import type {
    DefinitionCollection,
    DefinitionContext,
    DefinitionRecord,
    ExternalSourceConfig,
    IndexedDefinitions
} from './model';

export interface DefinitionSource {
    collect(
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<DefinitionCollection>;
}

export interface ExternalDefinitionSourceFactory {
    readonly type: string;

    validate(config: ExternalSourceConfig): readonly string[];

    create(
        definitionName: string,
        config: ExternalSourceConfig
    ): DefinitionSource;
}

export class ExternalSourceRegistry {
    private readonly factories = new Map<string, ExternalDefinitionSourceFactory>();

    register(factory: ExternalDefinitionSourceFactory): vscode.Disposable {
        if (this.factories.has(factory.type)) {
            throw new Error(`External definition source type "${factory.type}" is already registered.`);
        }

        this.factories.set(factory.type, factory);
        return new vscode.Disposable(() => this.factories.delete(factory.type));
    }

    has(type: string): boolean {
        return this.factories.has(type);
    }

    validate(config: ExternalSourceConfig): readonly string[] {
        const factory = this.factories.get(config.type);
        if (!factory) {
            return [`Unknown external definition source type "${config.type}".`];
        }

        return factory.validate(config);
    }

    create(
        definitionName: string,
        config: ExternalSourceConfig
    ): DefinitionSource {
        const factory = this.factories.get(config.type);
        if (!factory) {
            throw new Error(`Unknown external definition source type "${config.type}".`);
        }

        return factory.create(definitionName, config);
    }
}

export class InternalYamlDefinitionSource implements DefinitionSource {
    private readonly paths;

    constructor(
        private readonly definitionName: string,
        patterns: readonly string[],
        private readonly includeGraph: IncludeGraphResolver
    ) {
        this.paths = compileGlobSet(patterns);
    }

    async collect(
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<DefinitionCollection> {
        const graph = await this.includeGraph.resolve(context.rootDocument, token);
        const definitions: DefinitionRecord[] = [];

        for (const parsed of graph.documents) {
            for (const scalar of parsed.scalars) {
                if (scalar.value === undefined || !this.paths.matches(toYamlPath(scalar.path))) {
                    continue;
                }

                definitions.push({
                    definitionName: this.definitionName,
                    value: scalar.value,
                    uri: parsed.uri,
                    range: new vscode.Range(
                        parsed.document.positionAt(scalar.start),
                        parsed.document.positionAt(scalar.end)
                    ),
                    origin: 'internal'
                });
            }
        }

        return {
            definitions,
            issues: graph.issues,
            dependencies: graph.dependencies
        };
    }
}

export class DefinitionIndex {
    private sources: ReadonlyMap<string, DefinitionSource> = new Map();
    private generation = 0;
    private readonly cache = new Map<string, Promise<IndexedDefinitions>>();

    configure(sources: ReadonlyMap<string, DefinitionSource>): void {
        this.sources = new Map(sources);
        this.invalidate();
    }

    async get(
        definitionName: string,
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<IndexedDefinitions> {
        const cacheKey = [
            this.generation,
            definitionName,
            context.rootDocument.uri.toString(),
            context.rootDocument.version
        ].join(':');

        let pending = this.cache.get(cacheKey);
        if (!pending) {
            pending = this.load(definitionName, context, token);
            this.cache.set(cacheKey, pending);
            pending.catch(() => this.cache.delete(cacheKey));
        }

        return pending;
    }

    async find(
        definitionName: string,
        value: string,
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<readonly DefinitionRecord[]> {
        const indexed = await this.get(definitionName, context, token);
        return indexed.byValue.get(value) ?? [];
    }

    invalidate(_uri?: vscode.Uri): void {
        this.generation += 1;
        this.cache.clear();
    }

    clear(): void {
        this.sources = new Map();
        this.invalidate();
    }

    private async load(
        definitionName: string,
        context: DefinitionContext,
        token?: vscode.CancellationToken
    ): Promise<IndexedDefinitions> {
        const source = this.sources.get(definitionName);
        if (!source) {
            return {
                definitions: [],
                byValue: new Map(),
                dependencies: [],
                issues: [{
                    uri: context.configUri,
                    message: `No definition source is configured for "${definitionName}".`,
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'source-error'
                }]
            };
        }

        let collection: DefinitionCollection;
        try {
            collection = await source.collect(context, token);
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                throw error;
            }

            collection = {
                definitions: [],
                dependencies: [],
                issues: [{
                    uri: context.configUri,
                    message: `Definition source "${definitionName}" failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    severity: vscode.DiagnosticSeverity.Error,
                    code: 'source-error'
                }]
            };
        }

        const byValue = new Map<string, DefinitionRecord[]>();
        for (const definition of collection.definitions) {
            const existing = byValue.get(definition.value) ?? [];
            existing.push(definition);
            byValue.set(definition.value, existing);
        }

        return {
            ...collection,
            byValue
        };
    }
}
