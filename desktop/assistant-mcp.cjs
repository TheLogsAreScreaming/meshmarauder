'use strict';
// Assistant link: a small MCP (Model Context Protocol) server over stdio.
// An assistant such as Claude Desktop starts it; it forwards read-only
// questions to the running app's localhost-only API (integrations.json ->
// localApi.enabled). Mesh Marauder never transmits, so there is no send tool.
// Run with the app's own runtime:
//   ELECTRON_RUN_AS_NODE=1 "/Applications/Mesh Marauder.app/Contents/MacOS/Mesh Marauder" \
//     "/Applications/Mesh Marauder.app/Contents/Resources/app.asar/assistant-mcp.cjs"
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { loadSettings, TOKEN_FILE } = require('./integrations.cjs');
const { integrationsDir } = require('./integrations-paths.cjs');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'mesh-marauder-assistant-link';
const SERVER_VERSION = '1.0.0';
const RO = { readOnlyHint: true };
const TOOLS = [
  { name: 'get_network_status', description: 'Radio session state, nodes known / heard in the last hour, packet counts by type, and which integrations are on.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO },
  { name: 'list_nodes', description: 'Nodes this monitor has heard, most recent first: id, names, last heard (unix seconds), SNR/RSSI, hops, latest telemetry.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } }, additionalProperties: false }, annotations: RO },
  { name: 'recent_messages', description: 'Recent text-message activity (sender, time, channel, direct or broadcast). Message text is never decoded by this app.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 }, channel: { type: 'integer', minimum: 0, maximum: 7 } }, additionalProperties: false }, annotations: RO },
  { name: 'node_telemetry', description: 'Telemetry history (battery, voltage, temperature, humidity, pressure, channel use...) for one node by id (!abcd1234), short or long name.', inputSchema: { type: 'object', properties: { node: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 } }, required: ['node'], additionalProperties: false }, annotations: RO },
];

class ApiError extends Error {}

function makeClient(port, token, timeoutMs = 5000) {
  return function get(pathname, params = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: pathname + (query ? `?${query}` : ''), headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; });
        res.on('end', () => {
          let data = {}; try { data = JSON.parse(body || '{}'); } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data); else reject(new ApiError(data.error || `HTTP ${res.statusCode}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => reject(new ApiError('Mesh Marauder is not running or its assistant link is off (set localApi.enabled to true in integrations.json, then use Integrations > Reload Settings).')));
    });
  };
}

function clientFromDisk(dir = integrationsDir()) {
  const settings = loadSettings(dir);
  let token = '';
  try { token = fs.readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim(); } catch {}
  return makeClient(settings.localApi.port, token);
}

const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

class McpServer {
  constructor(clientFactory = clientFromDisk) { this.clientFactory = clientFactory; this.client = null; }
  get api() { if (!this.client) this.client = this.clientFactory(); return this.client; }
  async callTool(name, args) {
    if (name === 'get_network_status') return this.api('/api/status');
    if (name === 'list_nodes') return this.api('/api/nodes', { limit: args.limit ?? 50 });
    if (name === 'recent_messages') return this.api('/api/messages', { limit: args.limit ?? 20, channel: args.channel });
    if (name === 'node_telemetry') return this.api('/api/telemetry', { node: String(args.node || ''), limit: args.limit ?? 50 });
    throw new Error(`Unknown tool: ${name}`);
  }
  async handle(message) {
    if (!message || typeof message !== 'object') return error(null, -32600, 'Invalid request');
    const { id, method } = message;
    if (id === undefined || id === null) return null; // notification
    try {
      if (method === 'initialize') {
        const requested = message.params && message.params.protocolVersion;
        return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, instructions: 'Read-only view of what a local Mesh Marauder monitor has heard. Message text is not available.' } };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
      if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
      if (method === 'tools/call') {
        const params = message.params || {};
        if (!TOOLS.some(t => t.name === params.name)) return error(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const data = await this.callTool(params.name, params.arguments || {});
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false } };
        } catch (e) {
          if (e instanceof ApiError) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } };
          throw e;
        }
      }
      return error(id, -32601, `Method not found: ${method}`);
    } catch (e) { return error(id, -32603, String((e && e.message) || e)); }
  }
  serve(input = process.stdin, output = process.stdout) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let chain = Promise.resolve();
    rl.on('line', line => {
      const text = line.trim(); if (!text) return;
      chain = chain.then(async () => {
        let reply;
        try { reply = await this.handle(JSON.parse(text)); } catch { reply = error(null, -32700, 'Parse error'); }
        if (reply) output.write(JSON.stringify(reply) + '\n');
      });
    });
    return new Promise(resolve => rl.on('close', () => chain.then(resolve)));
  }
}

module.exports = { McpServer, makeClient, clientFromDisk, TOOLS, PROTOCOL_VERSIONS, SERVER_NAME, ApiError };

if (require.main === module) new McpServer().serve();
