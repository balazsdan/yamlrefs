import * as vscode from 'vscode';
import { Minimatch, type MinimatchOptions } from 'minimatch';

const matchOptions: MinimatchOptions = {
    dot: true,
    nocase: false,
    nocomment: true,
    nonegate: true,
    windowsPathsNoEscape: true
};

export interface CompiledGlobSet {
    readonly patterns: readonly string[];
    matches(candidate: string): boolean;
}

export function compileGlobSet(patterns: readonly string[]): CompiledGlobSet {
    const matchers = patterns.map(pattern => new Minimatch(pattern, matchOptions));

    return {
        patterns: [...patterns],
        matches(candidate: string): boolean {
            const normalized = candidate.replace(/\\/g, '/');
            return matchers.some(matcher => matcher.match(normalized));
        }
    };
}

export function validateGlob(pattern: string): string | undefined {
    try {
        new Minimatch(pattern, matchOptions);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

export function toYamlPath(segments: readonly string[]): string {
    const escaped = segments.map(segment => segment
        .replace(/~/g, '~0')
        .replace(/\//g, '~1'));

    return `/${escaped.join('/')}`;
}

export async function findWorkspaceFiles(
    baseUri: vscode.Uri,
    patterns: readonly string[],
    token?: vscode.CancellationToken
): Promise<readonly vscode.Uri[]> {
    const found = new Map<string, vscode.Uri>();

    for (const pattern of patterns) {
        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const relativePattern = new vscode.RelativePattern(baseUri, pattern);
        const matches = await vscode.workspace.findFiles(
            relativePattern,
            null,
            undefined,
            token
        );

        for (const uri of matches) {
            found.set(uri.toString(), uri);
        }
    }

    return [...found.values()].sort((left, right) =>
        left.toString().localeCompare(right.toString()));
}
