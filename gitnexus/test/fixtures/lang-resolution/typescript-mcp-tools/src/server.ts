import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { importedHandler } from './handlers.js';

const server = new McpServer({ name: 'fixture', version: '1' });

function formatSearch(query: string) { return query; }
function lookupSearch(query: string) { return formatSearch(query); }
export function searchFiles(query: string) { return lookupSearch(query); }

function formatFile(file: string) { return file; }
function lookupFile(file: string) { return formatFile(file); }
export const readFile = (file: string) => lookupFile(file);

function formatOther() { return 'other'; }
function lookupOther() { return formatOther(); }
export function unrelatedEntry() { return lookupOther(); }

server.registerTool('search-files', { description: 'Search files' }, searchFiles);
server.tool('read_file', 'Read a file', {}, readFile);
server.registerTool('inline_callback', {}, async () => 'inline');
server.tool('imported_callback', importedHandler);

function install(server: McpServer, searchFiles: () => string) {
  server.registerTool('parameter_callback', {}, searchFiles);
}

let mutable = () => 'mutable';
server.tool('mutable_callback', mutable);

function replaced() { return 'before'; }
replaced = () => 'after';
server.tool('reassigned_callback', replaced);

{
  const searchFiles = 'not callable';
  server.tool('shadowed_callback', searchFiles);
}

const alias = readFile;
server.tool('alias_callback', alias);

const expressionHandler = function () { return 'expression'; };
server.registerTool('function_expression_tool', {}, expressionHandler);

{
  const handler = () => lookupSearch('first');
  server.tool('first_block_callback', handler);
}
{
  const handler = () => lookupFile('second');
  server.tool('second_block_callback', handler);
}
