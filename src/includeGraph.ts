import * as vscode from 'vscode';

import type {
    IncludeGraph,
    ParsedYamlDocument,
    SourceIssue
} from './model';
import { YamlDocumentStore } from './yamlDocuments';

function includeUri(includingFile: vscode.Uri, rawPath: string): vscode.Uri {
    const normalized = rawPath.replace(/\\/g, '/');
    return vscode.Uri.joinPath(includingFile, '..', normalized);
}

function includeRange(
    document: vscode.TextDocument,
    start: number,
    end: number
): vscode.Range {
    return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

export class IncludeGraphResolver {
    constructor(private readonly documents: YamlDocumentStore) {}

    targetUri(includingFile: vscode.Uri, rawPath: string): vscode.Uri {
        return includeUri(includingFile, rawPath);
    }

    async resolve(
        rootDocument: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): Promise<IncludeGraph> {
        const resolvedDocuments: ParsedYamlDocument[] = [];
        const issues: SourceIssue[] = [];
        const dependencies = new Map<string, vscode.Uri>();
        const visited = new Set<string>();
        const visiting = new Set<string>();

        const visit = async (parsed: ParsedYamlDocument): Promise<void> => {
            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const key = parsed.uri.toString();
            if (visited.has(key)) {
                return;
            }

            visiting.add(key);
            dependencies.set(key, parsed.uri);
            resolvedDocuments.push(parsed);
            issues.push(...parsed.issues);

            for (const include of parsed.includes) {
                const target = this.targetUri(parsed.uri, include.rawPath);
                const targetKey = target.toString();
                dependencies.set(targetKey, target);

                if (visiting.has(targetKey)) {
                    issues.push({
                        uri: parsed.uri,
                        range: includeRange(parsed.document, include.start, include.end),
                        message: `Circular "${this.documents.includeKey}" detected: ${include.rawPath}`,
                        severity: vscode.DiagnosticSeverity.Error,
                        code: 'circular-include'
                    });
                    continue;
                }

                if (visited.has(targetKey)) {
                    continue;
                }

                try {
                    const includedDocument = await this.documents.open(target, token);
                    await visit(includedDocument);
                } catch (error) {
                    if (error instanceof vscode.CancellationError) {
                        throw error;
                    }

                    issues.push({
                        uri: parsed.uri,
                        range: includeRange(parsed.document, include.start, include.end),
                        message: `Included YAML could not be opened: ${include.rawPath}`,
                        severity: vscode.DiagnosticSeverity.Error,
                        code: 'missing-include'
                    });
                }
            }

            visiting.delete(key);
            visited.add(key);
        };

        await visit(this.documents.get(rootDocument));

        return {
            documents: resolvedDocuments,
            issues,
            dependencies: [...dependencies.values()]
        };
    }
}
