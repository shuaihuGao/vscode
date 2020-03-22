/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelCache, getLanguageModelCache } from '../languageModelCache';
import {
	SymbolInformation, SymbolKind, CompletionItem, Location, SignatureHelp, SignatureInformation, ParameterInformation,
	Definition, TextEdit, TextDocument, Diagnostic, DiagnosticSeverity, Range, CompletionItemKind, Hover, MarkedString,
	DocumentHighlight, DocumentHighlightKind, CompletionList, Position, FormattingOptions, FoldingRange, FoldingRangeKind, SelectionRange,
	LanguageMode, Settings, SemanticTokenData
} from './languageModes';
import { getWordAtText, startsWith, isWhitespaceOnly, repeat } from '../utils/strings';
import { HTMLDocumentRegions } from './embeddedSupport';

import * as ts from 'typescript';
import { join, resolve, dirname } from 'path';
import { URI } from 'vscode-uri';
import { getSemanticTokens, getSemanticTokenLegend } from './javascriptSemanticTokens';
import * as fs from 'fs';

const JS_WORD_REGEX = /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g;

let jquery_d_ts = join(__dirname, '../lib/jquery.d.ts').replace(/\\/g, '/'); // when packaged
if (!ts.sys.fileExists(jquery_d_ts)) {
	jquery_d_ts = join(__dirname, '../../lib/jquery.d.ts').replace(/\\/g, '/'); // from source
}
interface IImportScripts {
	files: string[];
	buffer: {
		[key: string]: {
			mdt: Date,
			doc: TextDocument,
			lastuse: number
		}
	};
}
export function getJavaScriptMode(documentRegions: LanguageModelCache<HTMLDocumentRegions>, languageId: 'javascript' | 'typescript', libDefinitionFiles?: string[]): LanguageMode {
	let jsDocuments = getLanguageModelCache<TextDocument>(10, 60, document => documentRegions.get(document).getEmbeddedDocument(languageId));

	const workingFile = languageId === 'javascript' ? 'vscode://javascript/1.js' : 'vscode://javascript/2.ts'; // the same 'file' is used for all contents

	let compilerOptions: ts.CompilerOptions = { allowNonTsExtensions: true, allowJs: true, lib: ['lib.es6.d.ts'], target: ts.ScriptTarget.Latest, moduleResolution: ts.ModuleResolutionKind.Classic };
	let currentTextDocument: TextDocument;
	let scriptFileVersion: number = 0;
	let importedScripts: IImportScripts = {
		files: [],
		buffer: {}
	};
	const definitionFiles: string[] = libDefinitionFiles || [];

	let bufferCleaner = setInterval(() => {
		Object.keys(importedScripts.buffer).forEach((key) => {
			let status = importedScripts.buffer[key];
			if (Date.now() - status.lastuse > 300000) {
				delete importedScripts.buffer[key];
				let ndt = (new Date()).toLocaleTimeString();
				console.log(`Time:${ndt}  Buffer cleared. Filename is:${key}`);
			}
		});
	}, 60000);
	function updateCurrentTextDocument(doc: TextDocument) {
		if (!currentTextDocument || doc.uri !== currentTextDocument.uri || doc.version !== currentTextDocument.version) {
			currentTextDocument = jsDocuments.get(doc);

			let s = documentRegions.get(doc).getImportedScripts();
			importedScripts.files.length = 0;
			s.forEach(el => {
				let dp = URI.parse(doc.uri).fsPath;
				let p = resolve(dirname(dp), el).replace(/\\/g, '/');
				if (ts.sys.fileExists(p)) {
					importedScripts.files.push(p);
				}
			});

			scriptFileVersion++;
		}
	}
	const host: ts.LanguageServiceHost = {
		getCompilationSettings: () => compilerOptions,
		getScriptFileNames: () => [workingFile, jquery_d_ts, ...definitionFiles, ...importedScripts.files],
		getScriptKind: (fileName) => fileName.substr(fileName.length - 2) === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS,
		getScriptVersion: (fileName: string) => {
			if (fileName === workingFile) {
				return String(scriptFileVersion);
			}
			let status = importedScripts.buffer[fileName];
			if (status) {
				return String(status.doc.version);
			}
			return '1'; // default lib an jquery.d.ts are static
		},
		getScriptSnapshot: (fileName: string) => {
			let doc: TextDocument;
			if (startsWith(fileName, 'vscode:')) {
				if (fileName === workingFile) {
					doc = currentTextDocument;
				} else {
					return {
						getText: (start, end) => ''.substr(start, end),
						getLength: () => 0,
						getChangeRange: () => undefined
					};
				}
			} else {
				let mtime = fs.statSync(fileName).mtime;
				let url = URI.file(fileName).toString();
				if (!importedScripts.buffer[fileName]) {
					importedScripts.buffer[fileName] = {
						mdt: mtime,
						doc: TextDocument.create(url, languageId, 0, ts.sys.readFile(fileName) || ''),
						lastuse: 0
					};
				} else if (importedScripts.buffer[fileName].mdt < mtime) {
					let stat = importedScripts.buffer[fileName];
					let ver = stat.doc.version + 1;
					stat.mdt = mtime;
					stat.doc = TextDocument.create(url, languageId, ver, ts.sys.readFile(fileName) || '');
					stat.lastuse = Date.now();
				}
				importedScripts.buffer[fileName].lastuse = Date.now();
				doc = importedScripts.buffer[fileName].doc;
			}
			return {
				getText: (start, end) => doc.getText().substring(start, end),
				getLength: () => doc.getText().length,
				getChangeRange: () => undefined
			};
		},
		getCurrentDirectory: () => '',
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options)
	};
	let jsLanguageService = ts.createLanguageService(host);

	let globalSettings: Settings = {};

	return {
		getId() {
			return languageId;
		},
		doValidation(document: TextDocument): Diagnostic[] {
			updateCurrentTextDocument(document);
			const syntaxDiagnostics: ts.Diagnostic[] = jsLanguageService.getSyntacticDiagnostics(workingFile);
			const semanticDiagnostics = jsLanguageService.getSemanticDiagnostics(workingFile);
			return syntaxDiagnostics.concat(semanticDiagnostics).map((diag: ts.Diagnostic): Diagnostic => {
				return {
					range: convertRange(currentTextDocument, diag),
					severity: DiagnosticSeverity.Error,
					source: languageId,
					message: ts.flattenDiagnosticMessageText(diag.messageText, '\n')
				};
			});
		},
		doComplete(document: TextDocument, position: Position): CompletionList {
			updateCurrentTextDocument(document);
			let offset = currentTextDocument.offsetAt(position);
			let completions = jsLanguageService.getCompletionsAtPosition(workingFile, offset, { includeExternalModuleExports: false, includeInsertTextCompletions: false });
			if (!completions) {
				return { isIncomplete: false, items: [] };
			}
			let replaceRange = convertRange(currentTextDocument, getWordAtText(currentTextDocument.getText(), offset, JS_WORD_REGEX));
			return {
				isIncomplete: false,
				items: completions.entries.map(entry => {
					return {
						uri: document.uri,
						position: position,
						label: entry.name,
						sortText: entry.sortText,
						kind: convertKind(entry.kind),
						textEdit: TextEdit.replace(replaceRange, entry.name),
						data: { // data used for resolving item details (see 'doResolve')
							languageId,
							uri: document.uri,
							offset: offset
						}
					};
				})
			};
		},
		doResolve(document: TextDocument, item: CompletionItem): CompletionItem {
			updateCurrentTextDocument(document);
			let details = jsLanguageService.getCompletionEntryDetails(workingFile, item.data.offset, item.label, undefined, undefined, undefined);
			if (details) {
				item.detail = ts.displayPartsToString(details.displayParts);
				item.documentation = ts.displayPartsToString(details.documentation);
				delete item.data;
			}
			return item;
		},
		doHover(document: TextDocument, position: Position): Hover | null {
			updateCurrentTextDocument(document);
			let info = jsLanguageService.getQuickInfoAtPosition(workingFile, currentTextDocument.offsetAt(position));
			if (info) {
				let contents = ts.displayPartsToString(info.displayParts);
				return {
					range: convertRange(currentTextDocument, info.textSpan),
					contents: MarkedString.fromPlainText(contents)
				};
			}
			return null;
		},
		doSignatureHelp(document: TextDocument, position: Position): SignatureHelp | null {
			updateCurrentTextDocument(document);
			let signHelp = jsLanguageService.getSignatureHelpItems(workingFile, currentTextDocument.offsetAt(position), undefined);
			if (signHelp) {
				let ret: SignatureHelp = {
					activeSignature: signHelp.selectedItemIndex,
					activeParameter: signHelp.argumentIndex,
					signatures: []
				};
				signHelp.items.forEach(item => {

					let signature: SignatureInformation = {
						label: '',
						documentation: undefined,
						parameters: []
					};

					signature.label += ts.displayPartsToString(item.prefixDisplayParts);
					item.parameters.forEach((p, i, a) => {
						let label = ts.displayPartsToString(p.displayParts);
						let parameter: ParameterInformation = {
							label: label,
							documentation: ts.displayPartsToString(p.documentation)
						};
						signature.label += label;
						signature.parameters!.push(parameter);
						if (i < a.length - 1) {
							signature.label += ts.displayPartsToString(item.separatorDisplayParts);
						}
					});
					signature.label += ts.displayPartsToString(item.suffixDisplayParts);
					ret.signatures.push(signature);
				});
				return ret;
			}
			return null;
		},
		findDocumentHighlight(document: TextDocument, position: Position): DocumentHighlight[] {
			updateCurrentTextDocument(document);
			const highlights = jsLanguageService.getDocumentHighlights(workingFile, currentTextDocument.offsetAt(position), [workingFile]);
			const out: DocumentHighlight[] = [];
			for (const entry of highlights || []) {
				for (const highlight of entry.highlightSpans) {
					out.push({
						range: convertRange(currentTextDocument, highlight.textSpan),
						kind: highlight.kind === 'writtenReference' ? DocumentHighlightKind.Write : DocumentHighlightKind.Text
					});
				}
			}
			return out;
		},
		findDocumentSymbols(document: TextDocument): SymbolInformation[] {
			updateCurrentTextDocument(document);
			let items = jsLanguageService.getNavigationBarItems(workingFile);
			if (items) {
				let result: SymbolInformation[] = [];
				let existing = Object.create(null);
				let collectSymbols = (item: ts.NavigationBarItem, containerLabel?: string) => {
					let sig = item.text + item.kind + item.spans[0].start;
					if (item.kind !== 'script' && !existing[sig]) {
						let symbol: SymbolInformation = {
							name: item.text,
							kind: convertSymbolKind(item.kind),
							location: {
								uri: document.uri,
								range: convertRange(currentTextDocument, item.spans[0])
							},
							containerName: containerLabel
						};
						existing[sig] = true;
						result.push(symbol);
						containerLabel = item.text;
					}

					if (item.childItems && item.childItems.length > 0) {
						for (let child of item.childItems) {
							collectSymbols(child, containerLabel);
						}
					}

				};

				items.forEach(item => collectSymbols(item));
				return result;
			}
			return [];
		},
		findDefinition(document: TextDocument, position: Position): Definition | null {
			updateCurrentTextDocument(document);
			let definition = jsLanguageService.getDefinitionAtPosition(workingFile, currentTextDocument.offsetAt(position));
			if (definition) {
				return definition.map(d => {
					let uri;
					let range;
					if (d.fileName === workingFile) {
						uri = document.uri;
						range = convertRange(currentTextDocument, d.textSpan);
					} else {
						let status = importedScripts.buffer[d.fileName];
						uri = status.doc.uri;
						range = convertRange(status.doc, d.textSpan);
					}
					return {
						uri: uri,
						range: range
					};
				});
			}
			return null;
		},
		findReferences(document: TextDocument, position: Position): Location[] {
			updateCurrentTextDocument(document);
			let references = jsLanguageService.getReferencesAtPosition(workingFile, currentTextDocument.offsetAt(position));
			if (references) {
				return references.map(d => {
					let doc = d.fileName === workingFile ? currentTextDocument : importedScripts.buffer[d.fileName].doc;
					return {
						uri: doc.uri,
						range: convertRange(doc, d.textSpan)
					};
				});
			}
			return [];
		},
		getSelectionRange(document: TextDocument, position: Position): SelectionRange {
			updateCurrentTextDocument(document);
			function convertSelectionRange(selectionRange: ts.SelectionRange): SelectionRange {
				const parent = selectionRange.parent ? convertSelectionRange(selectionRange.parent) : undefined;
				return SelectionRange.create(convertRange(currentTextDocument, selectionRange.textSpan), parent);
			}
			const range = jsLanguageService.getSmartSelectionRange(workingFile, currentTextDocument.offsetAt(position));
			return convertSelectionRange(range);
		},
		format(document: TextDocument, range: Range, formatParams: FormattingOptions, settings: Settings = globalSettings): TextEdit[] {
			currentTextDocument = documentRegions.get(document).getEmbeddedDocument('javascript', true);
			scriptFileVersion++;

			let formatterSettings = settings && settings.javascript && settings.javascript.format;

			let initialIndentLevel = computeInitialIndent(document, range, formatParams);
			let formatSettings = convertOptions(formatParams, formatterSettings, initialIndentLevel + 1);
			let start = currentTextDocument.offsetAt(range.start);
			let end = currentTextDocument.offsetAt(range.end);
			let lastLineRange = null;
			if (range.end.line > range.start.line && (range.end.character === 0 || isWhitespaceOnly(currentTextDocument.getText().substr(end - range.end.character, range.end.character)))) {
				end -= range.end.character;
				lastLineRange = Range.create(Position.create(range.end.line, 0), range.end);
			}
			let edits = jsLanguageService.getFormattingEditsForRange(workingFile, start, end, formatSettings);
			if (edits) {
				let result = [];
				for (let edit of edits) {
					if (edit.span.start >= start && edit.span.start + edit.span.length <= end) {
						result.push({
							range: convertRange(currentTextDocument, edit.span),
							newText: edit.newText
						});
					}
				}
				if (lastLineRange) {
					result.push({
						range: lastLineRange,
						newText: generateIndent(initialIndentLevel, formatParams)
					});
				}
				return result;
			}
			return [];
		},
		getFoldingRanges(document: TextDocument): FoldingRange[] {
			updateCurrentTextDocument(document);
			let spans = jsLanguageService.getOutliningSpans(workingFile);
			let ranges: FoldingRange[] = [];
			for (let span of spans) {
				let curr = convertRange(currentTextDocument, span.textSpan);
				let startLine = curr.start.line;
				let endLine = curr.end.line;
				if (startLine < endLine) {
					let foldingRange: FoldingRange = { startLine, endLine };
					let match = document.getText(curr).match(/^\s*\/(?:(\/\s*#(?:end)?region\b)|(\*|\/))/);
					if (match) {
						foldingRange.kind = match[1] ? FoldingRangeKind.Region : FoldingRangeKind.Comment;
					}
					ranges.push(foldingRange);
				}
			}
			return ranges;
		},
		onDocumentRemoved(document: TextDocument) {
			jsDocuments.onDocumentRemoved(document);
		},
		getSemanticTokens(document: TextDocument): SemanticTokenData[] {
			updateCurrentTextDocument(document);
			return getSemanticTokens(jsLanguageService, currentTextDocument, workingFile);
		},
		getSemanticTokenLegend(): { types: string[], modifiers: string[] } {
			return getSemanticTokenLegend();
		},
		dispose() {
			clearInterval(bufferCleaner);
			jsLanguageService.dispose();
			jsDocuments.dispose();
		}
	};
}




function convertRange(document: TextDocument, span: { start: number | undefined, length: number | undefined }): Range {
	if (typeof span.start === 'undefined') {
		const pos = document.positionAt(0);
		return Range.create(pos, pos);
	}
	const startPosition = document.positionAt(span.start);
	const endPosition = document.positionAt(span.start + (span.length || 0));
	return Range.create(startPosition, endPosition);
}

function convertKind(kind: string): CompletionItemKind {
	switch (kind) {
		case 'primitive type':
		case 'keyword':
			return CompletionItemKind.Keyword;
		case 'var':
		case 'local var':
			return CompletionItemKind.Variable;
		case 'property':
		case 'getter':
		case 'setter':
			return CompletionItemKind.Field;
		case 'function':
		case 'method':
		case 'construct':
		case 'call':
		case 'index':
			return CompletionItemKind.Function;
		case 'enum':
			return CompletionItemKind.Enum;
		case 'module':
			return CompletionItemKind.Module;
		case 'class':
			return CompletionItemKind.Class;
		case 'interface':
			return CompletionItemKind.Interface;
		case 'warning':
			return CompletionItemKind.File;
	}

	return CompletionItemKind.Property;
}

function convertSymbolKind(kind: string): SymbolKind {
	switch (kind) {
		case 'var':
		case 'local var':
		case 'const':
			return SymbolKind.Variable;
		case 'function':
		case 'local function':
			return SymbolKind.Function;
		case 'enum':
			return SymbolKind.Enum;
		case 'module':
			return SymbolKind.Module;
		case 'class':
			return SymbolKind.Class;
		case 'interface':
			return SymbolKind.Interface;
		case 'method':
			return SymbolKind.Method;
		case 'property':
		case 'getter':
		case 'setter':
			return SymbolKind.Property;
	}
	return SymbolKind.Variable;
}

function convertOptions(options: FormattingOptions, formatSettings: any, initialIndentLevel: number): ts.FormatCodeOptions {
	return {
		ConvertTabsToSpaces: options.insertSpaces,
		TabSize: options.tabSize,
		IndentSize: options.tabSize,
		IndentStyle: ts.IndentStyle.Smart,
		NewLineCharacter: '\n',
		BaseIndentSize: options.tabSize * initialIndentLevel,
		InsertSpaceAfterCommaDelimiter: Boolean(!formatSettings || formatSettings.insertSpaceAfterCommaDelimiter),
		InsertSpaceAfterSemicolonInForStatements: Boolean(!formatSettings || formatSettings.insertSpaceAfterSemicolonInForStatements),
		InsertSpaceBeforeAndAfterBinaryOperators: Boolean(!formatSettings || formatSettings.insertSpaceBeforeAndAfterBinaryOperators),
		InsertSpaceAfterKeywordsInControlFlowStatements: Boolean(!formatSettings || formatSettings.insertSpaceAfterKeywordsInControlFlowStatements),
		InsertSpaceAfterFunctionKeywordForAnonymousFunctions: Boolean(!formatSettings || formatSettings.insertSpaceAfterFunctionKeywordForAnonymousFunctions),
		InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis),
		InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets),
		InsertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces),
		InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces),
		PlaceOpenBraceOnNewLineForControlBlocks: Boolean(formatSettings && formatSettings.placeOpenBraceOnNewLineForFunctions),
		PlaceOpenBraceOnNewLineForFunctions: Boolean(formatSettings && formatSettings.placeOpenBraceOnNewLineForControlBlocks)
	};
}

function computeInitialIndent(document: TextDocument, range: Range, options: FormattingOptions) {
	let lineStart = document.offsetAt(Position.create(range.start.line, 0));
	let content = document.getText();

	let i = lineStart;
	let nChars = 0;
	let tabSize = options.tabSize || 4;
	while (i < content.length) {
		let ch = content.charAt(i);
		if (ch === ' ') {
			nChars++;
		} else if (ch === '\t') {
			nChars += tabSize;
		} else {
			break;
		}
		i++;
	}
	return Math.floor(nChars / tabSize);
}

function generateIndent(level: number, options: FormattingOptions) {
	if (options.insertSpaces) {
		return repeat(' ', level * options.tabSize);
	} else {
		return repeat('\t', level);
	}
}
