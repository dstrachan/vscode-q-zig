/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocumentPositionParams,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

let memory: WebAssembly.Memory;
let alloc_wasm: (len: number) => number;
let destroy_wasm: (ptr: number) => void;
let parse_wasm: (ptr: number, len: number) => number;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const print = (ptr: number, len: number) => {
  const mem = new Uint8Array(memory.buffer, ptr, len);
  console.log(decoder.decode(mem));
};

const initWasm = () => {
  const filePath = path.resolve(__dirname, '../../zig-out/lib/parser.wasm');
  const bytes = readFileSync(filePath);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, { env: { print } });
  memory = instance.exports.memory as WebAssembly.Memory;
  alloc_wasm = instance.exports.alloc as (len: number) => number;
  destroy_wasm = instance.exports.destroy as (ptr: number) => void;
  parse_wasm = instance.exports.parse as (ptr: number, len: number) => number;
};

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true,
      },
    },
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }

  initWasm();

  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ExampleSettings>(
      (change.settings.languageServerExample || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'languageServerExample',
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

const alloc = (data: Uint8Array) => {
  if (data.length === 0) return 0;
  const ptr = alloc_wasm(data.length);
  const mem = new Uint8Array(memory.buffer, ptr, data.length);
  mem.set(data);
  return ptr;
};

const parseNumber = (ptr: number) => {
  const view = new DataView(memory.buffer, ptr, 4);
  return view.getUint32(0, true);
};

const parseString = (ptr: number) => {
  const view = new DataView(memory.buffer, ptr, 8);
  const strPtr = view.getUint32(0, true);
  const len = view.getUint32(4, true);
  const mem = new Uint8Array(memory.buffer, strPtr, len);
  return decoder.decode(mem);
};

type Token = {
  tokenType: string;
  lexeme: string;
  errorMessage: string;
  line: number;
  char: number;
};

enum TokenType {
  // Punctuation.
  token_left_paren,
  token_right_paren,
  token_left_brace,
  token_right_brace,
  token_left_bracket,
  token_right_bracket,
  token_semicolon,
  token_colon,
  token_double_colon,

  // Verbs.
  token_plus,
  token_minus,
  token_star,
  token_percent,
  token_bang,
  token_ampersand,
  token_pipe,
  token_less,
  token_greater,
  token_equal,
  token_tilde,
  token_comma,
  token_caret,
  token_hash,
  token_underscore,
  token_dollar,
  token_question,
  token_at,
  token_dot,

  // Literals.
  token_bool,
  token_int,
  token_float,
  token_char,
  token_string,
  token_symbol,
  token_identifier,

  // Adverbs.
  token_apostrophe,
  token_apostrophe_colon,
  token_slash,
  token_slash_colon,
  token_backslash,
  token_backslash_colon,

  token_system,
  token_whitespace,
  token_comment,
  token_error,
  token_eof,
}

const parseTokens = (ptr: number, len: number) => {
  const tokens = new Array<Token>(len);
  for (let i = 0; i < len; i++) {
    const tokenType = TokenType[parseNumber(ptr)];
    const lexeme = parseString(ptr + 4);
    const errorMessage = parseString(ptr + 12);
    const line = parseNumber(ptr + 20);
    const char = parseNumber(ptr + 24);
    tokens[i] = {
      tokenType,
      lexeme,
      errorMessage,
      line,
      char,
    };
    ptr += 28;
  }
  return tokens;
};

const parseTokenResult = (ptr: number) => {
  const view = new DataView(memory.buffer, ptr, 8);
  const tokensPtr = view.getUint32(0, true);
  const len = view.getUint32(4, true);

  return {
    tokens: parseTokens(tokensPtr, len),
  };
};

const parse = (source: string) => {
  const encodedSource = encoder.encode(source);
  const sourcePtr = alloc(encodedSource);
  const ptr = parse_wasm(sourcePtr, encodedSource.length);
  const result = parseTokenResult(ptr);
  destroy_wasm(ptr);
  return result;
};

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  // In this simple example we get the settings for every validate run.
  const settings = await getDocumentSettings(textDocument.uri);

  // The validator creates diagnostics for all uppercase words length 2 and more
  const text = textDocument.getText();

  const start = performance.now();
  const result = parse(text);
  const duration = performance.now() - start;
  console.log(result, `Duration: ${duration.toFixed(2)} ms`);

  for (let i = 0; i < result.tokens.length; i++) {
    const token = result.tokens[i];
    if (token.tokenType === TokenType[TokenType.token_error]) {
      console.log(token);
    }
  }

  const pattern = /\b[A-Z]{2,}\b/g;
  let m: RegExpExecArray | null;

  let problems = 0;
  const diagnostics: Diagnostic[] = [];
  while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
    problems++;
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Warning,
      range: {
        start: textDocument.positionAt(m.index),
        end: textDocument.positionAt(m.index + m[0].length),
      },
      message: `${m[0]} is all uppercase.`,
      source: 'ex',
    };
    if (hasDiagnosticRelatedInformationCapability) {
      diagnostic.relatedInformation = [
        {
          location: {
            uri: textDocument.uri,
            range: Object.assign({}, diagnostic.range),
          },
          message: 'Spelling matters',
        },
        {
          location: {
            uri: textDocument.uri,
            range: Object.assign({}, diagnostic.range),
          },
          message: 'Particularly for names',
        },
      ];
    }
    diagnostics.push(diagnostic);
  }

  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return [
      {
        label: 'TypeScript',
        kind: CompletionItemKind.Text,
        data: 1,
      },
      {
        label: 'JavaScript',
        kind: CompletionItemKind.Text,
        data: 2,
      },
    ];
  },
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  if (item.data === 1) {
    item.detail = 'TypeScript details';
    item.documentation = 'TypeScript documentation';
  } else if (item.data === 2) {
    item.detail = 'JavaScript details';
    item.documentation = 'JavaScript documentation';
  }
  return item;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
