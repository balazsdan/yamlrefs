import * as vscode from 'vscode';

export type DefinitionOrigin = 'internal' | 'external';

export type YamlScalarStyle = 'plain' | 'single-quoted' | 'double-quoted';

export type IssueCode =
    | 'unknown-reference'
    | 'missing-include'
    | 'circular-include'
    | 'invalid-include'
    | 'source-error';

export const DEFAULT_INCLUDE_KEY = '$include';

export interface InternalDefinitionConfig {
    readonly paths: readonly string[];
    readonly references: readonly string[];
}

export interface ExternalSourceConfig {
    readonly type: string;
    readonly files: readonly string[];
    readonly [key: string]: unknown;
}

export interface ExternalDefinitionConfig {
    readonly references: readonly string[];
    readonly source: ExternalSourceConfig;
}

export interface YamlRefsConfig {
    readonly version: 1;
    readonly includeKey: string;
    readonly definitions: Readonly<Record<string, InternalDefinitionConfig>>;
    readonly externalDefinitions: Readonly<Record<string, ExternalDefinitionConfig>>;
}

export interface ConfigIssue {
    readonly uri: vscode.Uri;
    readonly range: vscode.Range;
    readonly message: string;
    readonly severity: vscode.DiagnosticSeverity;
}

export interface ConfigLoadResult {
    readonly configUri: vscode.Uri;
    readonly configDirectory: vscode.Uri;
    readonly config?: YamlRefsConfig;
    readonly issues: readonly ConfigIssue[];
}

export interface SourceIssue {
    readonly uri: vscode.Uri;
    readonly range?: vscode.Range;
    readonly message: string;
    readonly severity: vscode.DiagnosticSeverity;
    readonly code?: IssueCode;
}

export interface DefinitionRecord {
    readonly definitionName: string;
    readonly value: string;
    readonly uri: vscode.Uri;
    readonly range: vscode.Range;
    readonly origin: DefinitionOrigin;
}

export interface DefinitionCollection {
    readonly definitions: readonly DefinitionRecord[];
    readonly issues: readonly SourceIssue[];
    readonly dependencies: readonly vscode.Uri[];
}

export interface IndexedDefinitions extends DefinitionCollection {
    readonly byValue: ReadonlyMap<string, readonly DefinitionRecord[]>;
}

export interface DefinitionContext {
    readonly rootDocument: vscode.TextDocument;
    readonly configUri: vscode.Uri;
    readonly configDirectory: vscode.Uri;
}

export interface YamlScalarNode {
    readonly path: readonly string[];
    readonly value?: string;
    readonly start: number;
    readonly end: number;
    readonly style: YamlScalarStyle;
}

export interface IncludeEntry {
    readonly rawPath: string;
    readonly start: number;
    readonly end: number;
}

export interface ParsedYamlDocument {
    readonly uri: vscode.Uri;
    readonly document: vscode.TextDocument;
    readonly scalars: readonly YamlScalarNode[];
    readonly includes: readonly IncludeEntry[];
    readonly issues: readonly SourceIssue[];
}

export interface IncludeGraph {
    readonly documents: readonly ParsedYamlDocument[];
    readonly issues: readonly SourceIssue[];
    readonly dependencies: readonly vscode.Uri[];
}

export interface ReferenceOccurrence {
    readonly definitionName: string;
    readonly path: readonly string[];
    readonly value?: string;
    readonly range: vscode.Range;
    readonly replacementRange: vscode.Range;
    readonly start: number;
    readonly end: number;
    readonly style: YamlScalarStyle;
}

export interface ResolutionResult {
    readonly matches: readonly DefinitionRecord[];
    readonly indexed: IndexedDefinitions;
}

export interface ValidationIssue extends SourceIssue {
    readonly code: IssueCode;
}

export interface IniEntry {
    readonly section: string;
    readonly key: string;
    readonly value: string;
    readonly keyStart: number;
    readonly keyEnd: number;
    readonly valueStart: number;
    readonly valueEnd: number;
}

export interface ParsedIniDocument {
    readonly uri: vscode.Uri;
    readonly document: vscode.TextDocument;
    readonly entries: readonly IniEntry[];
    readonly issues: readonly SourceIssue[];
}
