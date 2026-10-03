import { McpServer as Server } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new Server({ name: 'javascript', version: '1' });
function jsPing() { return 'pong'; }
server.registerTool('js_ping', { description: 'Ping JavaScript' }, jsPing);
