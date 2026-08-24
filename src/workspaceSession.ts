import * as vscode from 'vscode';

import { ConfigLoader, ConfigValidator } from './config';
import {
    DefinitionIndex,
    ExternalSourceRegistry,
    InternalYamlDefinitionSource,
    type DefinitionSource
} from './definitionSources';
import { IncludeGraphResolver } from './includeGraph';
import type {
    ConfigIssue,
    DefinitionContext,
    IndexedDefinitions,
    ReferenceOccurrence,
    ResolutionResult,
    ValidationIssue
} from './model';
import {
    ReferenceResolver,
    ReferenceScanner,
    ReferenceValidator
} from './references';
import { YamlDocumentParser, YamlDocumentStore } from './yamlDocuments';

export class WorkspaceSession implements vscode.Disposable {
    private readonly documents = new YamlDocumentStore(new YamlDocumentParser());
    private readonly includes = new IncludeGraphResolver(this.documents);
    private readonly index = new DefinitionIndex();
    private readonly scanner = new ReferenceScanner(this.documents);
    private readonly resolver = new ReferenceResolver(this.index);
    private readonly validator = new ReferenceValidator(
        this.scanner,
        this.resolver,
        this.includes
    );
    private readonly configLoader: ConfigLoader;
    private readonly reloadEmitter = new vscode.EventEmitter<void>();
    private configIssues: readonly ConfigIssue[] = [];
    private configured = false;
    private reloadGeneration = 0;

    readonly onDidReload = this.reloadEmitter.event;

    constructor(
        readonly folder: vscode.WorkspaceFolder,
        private readonly externalSources: ExternalSourceRegistry
    ) {
        this.configLoader = new ConfigLoader(new ConfigValidator(externalSources));
    }

    get configUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.folder.uri, '.yamlrefs.json');
    }

    get issues(): readonly ConfigIssue[] {
        return this.configIssues;
    }

    get isConfigured(): boolean {
        return this.configured;
    }

    async initialize(): Promise<void> {
        await this.reloadConfig();
    }

    async reloadConfig(): Promise<void> {
        const generation = ++this.reloadGeneration;
        let loaded;
        try {
            loaded = await this.configLoader.load(this.folder);
        } catch (error) {
            if (generation !== this.reloadGeneration) {
                return;
            }

            const position = new vscode.Position(0, 0);
            this.configIssues = [{
                uri: this.configUri,
                range: new vscode.Range(position, position),
                message: `.yamlrefs.json could not be loaded: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                severity: vscode.DiagnosticSeverity.Error
            }];
            this.configured = false;
            this.index.clear();
            this.scanner.configure(undefined);
            this.reloadEmitter.fire();
            return;
        }

        if (generation !== this.reloadGeneration) {
            return;
        }

        this.configIssues = loaded.issues;
        this.configured = loaded.config !== undefined;

        if (!loaded.config) {
            this.index.clear();
            this.scanner.configure(undefined);
            this.reloadEmitter.fire();
            return;
        }

        const sources = new Map<string, DefinitionSource>();
        for (const [definitionName, definition] of Object.entries(loaded.config.definitions)) {
            sources.set(definitionName, new InternalYamlDefinitionSource(
                definitionName,
                definition.paths,
                this.includes
            ));
        }

        for (const [definitionName, definition] of Object.entries(loaded.config.externalDefinitions)) {
            sources.set(definitionName, this.externalSources.create(
                definitionName,
                definition.source
            ));
        }

        this.index.configure(sources);
        this.scanner.configure(loaded.config);
        this.reloadEmitter.fire();
    }

    isConfigFile(uri: vscode.Uri): boolean {
        return this.configLoader.isConfigFile(uri, this.folder);
    }

    invalidate(uri: vscode.Uri): void {
        this.documents.invalidate(uri);
        this.index.invalidate(uri);
    }

    findReferencesAt(
        document: vscode.TextDocument,
        position: vscode.Position
    ): readonly ReferenceOccurrence[] {
        if (!this.configured) {
            return [];
        }

        return this.scanner.findAt(document, position);
    }

    async includeTargetAt(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken
    ): Promise<vscode.Uri | undefined> {
        const parsed = this.documents.get(document);
        const include = parsed.includes.find(entry => {
            const range = new vscode.Range(
                document.positionAt(entry.start),
                document.positionAt(entry.end)
            );
            return range.contains(position);
        });

        if (!include) {
            return undefined;
        }

        const target = this.includes.targetUri(document.uri, include.rawPath);
        try {
            await this.documents.open(target, token);
            return target;
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                throw error;
            }
            return undefined;
        }
    }

    candidates(
        document: vscode.TextDocument,
        occurrence: ReferenceOccurrence,
        token?: vscode.CancellationToken
    ): Promise<IndexedDefinitions> {
        return this.resolver.candidates(
            occurrence,
            this.contextFor(document),
            token
        );
    }

    resolve(
        document: vscode.TextDocument,
        occurrence: ReferenceOccurrence,
        token?: vscode.CancellationToken
    ): Promise<ResolutionResult> {
        return this.resolver.resolve(
            occurrence,
            this.contextFor(document),
            token
        );
    }

    validate(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<readonly ValidationIssue[]> {
        if (!this.configured) {
            return Promise.resolve([]);
        }

        return this.validator.validate(document, this.contextFor(document), token);
    }

    dispose(): void {
        this.reloadGeneration += 1;
        this.reloadEmitter.dispose();
        this.documents.clear();
        this.index.clear();
    }

    private contextFor(document: vscode.TextDocument): DefinitionContext {
        return {
            rootDocument: document,
            configUri: this.configUri,
            configDirectory: this.folder.uri
        };
    }
}
