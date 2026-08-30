import * as vscode from 'vscode';

import { ExternalSourceRegistry } from './definitionSources';
import { IniDefinitionSourceFactory } from './ini';
import { JsonDefinitionSourceFactory } from './json';
import {
    DiagnosticsController,
    IncludeDefinitionProvider,
    ReferenceCompletionProvider,
    ReferenceDefinitionProvider,
    type WorkspaceSessionLookup
} from './languageProviders';
import { WorkspaceSession } from './workspaceSession';

interface SessionEntry {
    readonly session: WorkspaceSession;
    readonly reloadSubscription: vscode.Disposable;
}

class ExtensionController implements vscode.Disposable, WorkspaceSessionLookup {
    private readonly sessions = new Map<string, SessionEntry>();
    private readonly externalSources = new ExternalSourceRegistry();
    private readonly collection = vscode.languages.createDiagnosticCollection('yamlrefs');
    private readonly diagnostics = new DiagnosticsController(this.collection, this);
    private readonly disposables: vscode.Disposable[] = [];
    private disposed = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async start(): Promise<void> {
        this.disposables.push(
            this.collection,
            this.diagnostics,
            this.externalSources.register(new IniDefinitionSourceFactory()),
            this.externalSources.register(new JsonDefinitionSourceFactory())
        );

        const folders = vscode.workspace.workspaceFolders ?? [];
        await Promise.all(folders.map(folder => this.addWorkspace(folder)));

        this.disposables.push(
            vscode.languages.registerCompletionItemProvider(
                { language: 'yaml' },
                new ReferenceCompletionProvider(this),
                ':',
                ' ',
                '-',
                '"',
                "'"
            ),
            vscode.languages.registerDefinitionProvider(
                { language: 'yaml' },
                new ReferenceDefinitionProvider(this)
            ),
            vscode.languages.registerDefinitionProvider(
                { language: 'yaml' },
                new IncludeDefinitionProvider(this)
            ),
            vscode.workspace.onDidChangeWorkspaceFolders(event => {
                for (const folder of event.removed) {
                    this.removeWorkspace(folder);
                }
                for (const folder of event.added) {
                    void this.addWorkspace(folder).then(() => this.diagnostics.schedule(0));
                }
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                void this.handleDocumentChange(event.document);
            }),
            vscode.workspace.onDidSaveTextDocument(document => {
                void this.handleDocumentChange(document);
            }),
            vscode.workspace.onDidOpenTextDocument(document => {
                if (document.languageId === 'yaml') {
                    this.diagnostics.schedule();
                }
            }),
            vscode.workspace.onDidCloseTextDocument(document => {
                if (document.languageId === 'yaml') {
                    this.diagnostics.clear(document.uri);
                }
            })
        );

        const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml,ini,json}');
        const configWatcher = vscode.workspace.createFileSystemWatcher('**/.yamlrefs.json');
        this.disposables.push(sourceWatcher, configWatcher);
        this.disposables.push(
            sourceWatcher.onDidCreate(uri => this.handleFileChange(uri)),
            sourceWatcher.onDidChange(uri => this.handleFileChange(uri)),
            sourceWatcher.onDidDelete(uri => this.handleFileChange(uri)),
            configWatcher.onDidCreate(uri => void this.handleConfigChange(uri)),
            configWatcher.onDidChange(uri => void this.handleConfigChange(uri)),
            configWatcher.onDidDelete(uri => void this.handleConfigChange(uri))
        );

        await this.diagnostics.validateOpenDocuments();
    }

    sessionFor(uri: vscode.Uri): WorkspaceSession | undefined {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            return undefined;
        }

        return this.sessions.get(folder.uri.toString())?.session;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

        for (const entry of this.sessions.values()) {
            entry.reloadSubscription.dispose();
            entry.session.dispose();
        }
        this.sessions.clear();

        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
    }

    private async addWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
        const key = folder.uri.toString();
        if (this.sessions.has(key)) {
            return;
        }

        const session = new WorkspaceSession(folder, this.externalSources);
        const reloadSubscription = session.onDidReload(() => {
            this.diagnostics.publishConfigIssues(session);
            this.diagnostics.schedule(0);
        });
        this.sessions.set(key, { session, reloadSubscription });
        await session.initialize();
        this.diagnostics.publishConfigIssues(session);
    }

    private removeWorkspace(folder: vscode.WorkspaceFolder): void {
        const key = folder.uri.toString();
        const entry = this.sessions.get(key);
        if (!entry) {
            return;
        }

        entry.reloadSubscription.dispose();
        entry.session.dispose();
        this.sessions.delete(key);
        this.diagnostics.clear(entry.session.configUri);
    }

    private async handleDocumentChange(document: vscode.TextDocument): Promise<void> {
        const session = this.sessionFor(document.uri);
        if (!session) {
            return;
        }

        if (session.isConfigFile(document.uri)) {
            await session.reloadConfig();
            this.diagnostics.publishConfigIssues(session);
        } else {
            session.invalidate(document.uri);
        }

        this.diagnostics.schedule();
    }

    private handleFileChange(uri: vscode.Uri): void {
        const session = this.sessionFor(uri);
        if (!session) {
            return;
        }

        session.invalidate(uri);
        this.diagnostics.schedule();
    }

    private async handleConfigChange(uri: vscode.Uri): Promise<void> {
        const session = this.sessionFor(uri);
        if (!session || !session.isConfigFile(uri)) {
            return;
        }

        await session.reloadConfig();
        this.diagnostics.publishConfigIssues(session);
        this.diagnostics.schedule(0);
    }
}

let controller: ExtensionController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    controller = new ExtensionController(context);
    context.subscriptions.push(controller);
    await controller.start();
}

export function deactivate(): void {
    controller?.dispose();
    controller = undefined;
}
