#!/usr/bin/env node
/**
 * Smoke test for MCP prompts.
 *
 * Spawns the MCP server via stdio, sends JSON-RPC requests, and verifies
 * that all 6 prompts are listed and that the 4 skill-based prompts
 * interpolate arguments correctly.
 *
 * Usage:
 *   cd gitnexus && npm run build && node test/smoke-prompts.cjs
 *
 * Requires at least one indexed repo in the global registry.
 */

const { spawn } = require('child_process');

function send(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

const proc = spawn('node', ['dist/cli/index.js', 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname + '/..'
});

let stdout = '';
proc.stderr.on('data', () => {});
proc.stdout.on('data', (d) => { stdout += d.toString(); });

setTimeout(() => {
  send(proc, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
  });
}, 2000);

setTimeout(() => {
  send(proc, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send(proc, { jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} });
}, 3000);

setTimeout(() => {
  send(proc, { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'exploring', arguments: { query: 'auth flow' } } });
  send(proc, { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'refactoring', arguments: { target: 'parseFile', action: 'extract' } } });
  send(proc, { jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'debugging', arguments: { symptom: 'null pointer' } } });
  send(proc, { jsonrpc: '2.0', id: 6, method: 'prompts/get', params: { name: 'impact_analysis', arguments: { target: 'startMCPServer' } } });
}, 4000);

setTimeout(() => {
  const lines = stdout.split('\n').filter(l => l.trim());
  const results = {};
  for (const line of lines) {
    try { const m = JSON.parse(line); if (m.id) results[m.id] = m; } catch {}
  }

  let pass = 0, fail = 0;

  // prompts/list
  const prompts = results[2]?.result?.prompts;
  if (prompts && prompts.length === 6) {
    console.log('PASS  prompts/list - 6 prompts:');
    for (const p of prompts) {
      const args = (p.arguments || []).map(a => a.name + (a.required ? '*' : '')).join(', ');
      console.log('        ' + p.name + '(' + args + ')');
    }
    pass++;
  } else {
    console.log('FAIL  prompts/list - expected 6, got ' + (prompts ? prompts.length : 'none'));
    fail++;
  }

  // exploring
  const e = results[3]?.result?.messages?.[0]?.content?.text;
  if (e && e.includes('auth flow')) { console.log('PASS  exploring - query interpolated'); pass++; }
  else { console.log('FAIL  exploring'); fail++; }

  // refactoring
  const r = results[4]?.result?.messages?.[0]?.content?.text;
  if (r && r.includes('parseFile') && r.includes('Extract workflow')) { console.log('PASS  refactoring - target + extract action'); pass++; }
  else { console.log('FAIL  refactoring'); fail++; }

  // debugging
  const d = results[5]?.result?.messages?.[0]?.content?.text;
  if (d && d.includes('null pointer')) { console.log('PASS  debugging - symptom interpolated'); pass++; }
  else { console.log('FAIL  debugging'); fail++; }

  // impact_analysis
  const i = results[6]?.result?.messages?.[0]?.content?.text;
  if (i && i.includes('startMCPServer')) { console.log('PASS  impact_analysis - target interpolated'); pass++; }
  else { console.log('FAIL  impact_analysis'); fail++; }

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');

  proc.kill();
  process.exit(fail > 0 ? 1 : 0);
}, 6000);
