const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const I = require('../integrations.cjs');
const M = require('../assistant-mcp.cjs');

const rpc = (server, method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const PACKETS = [
  { variant: 'packet', meta: { from: 0xa1b2c3d4, to: 0xffffffff, channel: 0, rxTime: 1700000000, portnum: 'NODEINFO_APP', user: { longName: 'Base Camp', shortName: 'BC' } } },
  { variant: 'packet', meta: { from: 0xa1b2c3d4, to: 0xffffffff, channel: 0, rxTime: 1700000001, portnum: 'TEXT_MESSAGE_APP' } },
  { variant: 'packet', meta: { from: 0xa1b2c3d4, to: 0xffffffff, channel: 0, rxTime: 1700000002, portnum: 'TELEMETRY_APP', telemetry: { battery_percent: 55 } } },
];

test('MCP server answers over a live localhost API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-'));
  const hub = new I.IntegrationHub({ settings: { localApi: { enabled: true } }, dataDir: dir });
  PACKETS.forEach(p => hub.observe(p));
  const api = new I.LocalApiServer(hub, 0, dir); const port = await api.start();
  try {
    const server = new M.McpServer(() => M.makeClient(port, api.token));
    const init = await rpc(server, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.protocolVersion, '2024-11-05'); assert.ok(init.result.capabilities.tools);
    assert.equal((await rpc(server, 'initialize', { protocolVersion: 'nope' })).result.protocolVersion, M.PROTOCOL_VERSIONS[0]);
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const names = (await rpc(server, 'tools/list')).result.tools.map(t => t.name);
    assert.deepEqual(names, ['get_network_status', 'list_nodes', 'recent_messages', 'node_telemetry']);
    assert.ok((await rpc(server, 'tools/list')).result.tools.every(t => t.annotations.readOnlyHint));
    const call = async (name, args = {}) => JSON.parse((await rpc(server, 'tools/call', { name, arguments: args })).result.content[0].text);
    assert.equal((await call('list_nodes')).nodes[0].long_name, 'Base Camp');
    const msgs = await call('recent_messages'); assert.equal(msgs.messages[0].from_name, 'Base Camp'); assert.equal('text' in msgs.messages[0], false);
    assert.equal((await call('node_telemetry', { node: 'BC' })).points[0].battery_percent, 55);
    assert.equal((await call('get_network_status')).nodes_known, 1);
    assert.equal((await rpc(server, 'tools/call', { name: 'send_message', arguments: { text: 'x' } })).error.code, -32602);
    assert.equal((await rpc(server, 'bogus')).error.code, -32601);
  } finally { await api.stop(); }
});

test('app off is a tool error, not a crash', async () => {
  const server = new M.McpServer(() => M.makeClient(1, 'x', 1000));
  const r = await rpc(server, 'tools/call', { name: 'list_nodes', arguments: {} });
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /localApi\.enabled/);
});

test('script speaks newline-delimited JSON-RPC on stdio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-'));
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map(m => JSON.stringify(m)).join('\n') + '\nnot json\n';
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'assistant-mcp.cjs')], { input, encoding: 'utf8', env: { ...process.env, MESH_MARAUDER_INTEGRATIONS_DIR: dir }, timeout: 20000 });
  const replies = out.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(replies.map(r => r.id), [1, 2, null]);
  assert.equal(replies[0].result.serverInfo.name, M.SERVER_NAME); assert.equal(replies[2].error.code, -32700);
});
