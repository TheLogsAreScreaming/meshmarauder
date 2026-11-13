const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const I = require('../integrations.cjs');
const { integrationsDir } = require('../integrations-paths.cjs');
const { createMeshtasticCodec } = require('../meshtastic-codec.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mm-int-'));
const pkt = meta => ({ variant: 'packet', summary: 'x', meta: { from: 0x1234abcd, to: 0xffffffff, channel: 0, rxTime: 1700000000, rxSnr: 6.5, rxRssi: -88, hopStart: 3, hopLimit: 1, encrypted: false, ...meta } });
const INFO = pkt({ portnum: 'NODEINFO_APP', user: { longName: 'Ridge Top', shortName: 'RT' } });
const TEXT = pkt({ portnum: 'TEXT_MESSAGE_APP' });
const TELEM = pkt({ portnum: 'TELEMETRY_APP', telemetry: { battery_percent: 87, voltage_volts: 4.01, temperature_celsius: 21.5 } });

class FakeDeliverer extends I.Deliverer { constructor() { super(); this.sent = []; } submit(url, body, headers) { this.sent.push({ url, body, headers }); } }
const hub = (settings = {}) => new I.IntegrationHub({ settings, dataDir: tmp(), deliverer: new FakeDeliverer() });

test('defaults are all off and bad values are refused', () => {
  const s = I.normalizeSettings({});
  assert.equal(s.webhooks.enabled, false); assert.equal(s.localApi.enabled, false); assert.equal(s.localApi.port, I.DEFAULT_PORT);
  const t = I.normalizeSettings({ webhooks: { enabled: 'yes', urls: ['https://a.example/h', 'ftp://x', 'not a url'], events: ['message', 'bogus'] }, localApi: { port: 80 } });
  assert.equal(t.webhooks.enabled, false, 'only literal true enables');
  assert.deepEqual(t.webhooks.urls, ['https://a.example/h']); assert.deepEqual(t.webhooks.events, ['message']); assert.equal(t.localApi.port, I.DEFAULT_PORT);
  assert.deepEqual(I.normalizeSettings(I.DEFAULT_SETTINGS).webhooks.enabled, false);
});

test('settings file is created private and loaded', () => {
  const dir = tmp(); const file = I.ensureSettingsFile(dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, JSON.stringify({ localApi: { enabled: true, port: 9600 } }));
  assert.equal(I.loadSettings(dir).localApi.port, 9600);
  fs.writeFileSync(file, '{broken'); assert.equal(I.loadSettings(dir).localApi.enabled, false);
});

test('integrations folder is fixed and overridable', () => {
  assert.equal(integrationsDir({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/Mesh Marauder/integrations');
  assert.equal(integrationsDir({ MESH_MARAUDER_INTEGRATIONS_DIR: '/x' }, 'darwin', '/h'), '/x');
});

test('session messages become node, message (metadata only) and telemetry events', () => {
  const kinds = I.normalizeMessage(TEXT).map(e => e[0]); assert.deepEqual(kinds, ['node', 'message']);
  const msg = I.normalizeMessage(TEXT)[1][1]; assert.equal('text' in msg, false); assert.equal(msg.node_id, '!1234abcd'); assert.equal(msg.direct, false);
  assert.equal(I.normalizeMessage(TEXT)[0][1].hops_away, 2);
  assert.equal(I.normalizeMessage(TELEM)[1][1].metrics.battery_percent, 87);
  assert.deepEqual(I.normalizeMessage({ variant: 'myInfo' }), []); assert.deepEqual(I.normalizeMessage(null), []);
  assert.deepEqual(I.normalizeMessage(pkt({ from: 0 })), []);
});

test('webhooks: off by default, filtered by event, signed', () => {
  const off = hub({ webhooks: { urls: ['http://h/1'] } }); off.observe(TEXT); assert.equal(off.deliverer.sent.length, 0);
  const h = hub({ webhooks: { enabled: true, urls: ['http://h/1'], events: ['telemetry'], secret: 's3' } });
  for (const p of [INFO, TEXT, TELEM]) h.observe(p);
  assert.equal(h.deliverer.sent.length, 1);
  const { body, headers } = h.deliverer.sent[0]; const doc = JSON.parse(body);
  assert.equal(doc.event, 'telemetry'); assert.equal(doc.data.metrics.temperature_celsius, 21.5);
  assert.equal(headers['X-Mesh-Signature'], I.sign('s3', body));
});

test('deliverer retries, counts failures and bounds its queue', async () => {
  let calls = 0; const d = new I.Deliverer({ post: async () => { calls += 1; throw new Error('down'); }, retryDelayMs: 0 });
  assert.equal(await d.deliverNow('http://h/x', '{}', {}), false); assert.equal(calls, 2); assert.equal(d.stats.failed, 1);
  const ok = []; const e = new I.Deliverer({ post: async (u, b) => { ok.push(b); return 204; } });
  e.submit('http://h', 'a', {}); e.submit('http://h', 'b', {}); await e.idle; assert.deepEqual(ok, ['a', 'b']); assert.equal(e.stats.sent, 2);
  const full = new I.Deliverer({ post: () => new Promise(() => {}), maxQueue: 1 }); full.submit('http://h', '1', {}); full.submit('http://h', '2', {}); full.submit('http://h', '3', {});
  assert.equal(full.stats.dropped, 1); full.stop();
});

test('prometheus and influx output', () => {
  const h = hub(); for (const p of [INFO, TEXT, TELEM]) h.observe(p);
  const prom = I.renderPrometheus(h.state);
  assert.match(prom, /mesh_node_battery_percent\{node="!1234abcd",name="Ridge Top"\} 87/);
  assert.match(prom, /mesh_packets_total\{portnum="TEXT_MESSAGE_APP"\} 1/);
  assert.equal(I.influxLine('!1234abcd', { battery_percent: 87, voltage_volts: 4.01 }, 1700000000, 'Ridge Top'), 'mesh_telemetry,node=!1234abcd,name=Ridge\\ Top battery_percent=87.0,voltage_volts=4.01 1700000000');
  assert.match(I.exportInflux(h.state), /temperature_celsius=21.5/);
});

test('influx file and push', () => {
  const h = hub({ influx: { file: 'telemetry.lp', url: 'http://127.0.0.1:8086/api/v2/write?org=o&bucket=b&precision=s', token: 'tok' } });
  h.observe(INFO); h.observe(TELEM);
  assert.match(fs.readFileSync(path.join(h.dataDir, 'telemetry.lp'), 'utf8'), /^mesh_telemetry,node=!1234abcd,name=Ridge\\ Top /);
  assert.equal(h.deliverer.sent[0].headers.Authorization, 'Token tok');
});

test('codec decodes telemetry readings and node names but never message text', async () => {
  const codec = await createMeshtasticCodec();
  const [{ create, toBinary }, pb] = await Promise.all([import('@bufbuild/protobuf'), import('@meshtastic/protobufs')]);
  const wrap = (portnum, payload) => toBinary(pb.Mesh.FromRadioSchema, create(pb.Mesh.FromRadioSchema, { payloadVariant: { case: 'packet', value: create(pb.Mesh.MeshPacketSchema, { from: 0x1234abcd, to: 0xffffffff, hopStart: 3, hopLimit: 2, payloadVariant: { case: 'decoded', value: create(pb.Mesh.DataSchema, { portnum, payload }) } }) } }));
  const tel = toBinary(pb.Telemetry.TelemetrySchema, create(pb.Telemetry.TelemetrySchema, { variant: { case: 'environmentMetrics', value: create(pb.Telemetry.EnvironmentMetricsSchema, { temperature: 19.5, relativeHumidity: 44 }) } }));
  const d1 = codec.decodeFromRadio(wrap(pb.Portnums.PortNum.TELEMETRY_APP, tel));
  assert.equal(d1.meta.telemetry.temperature_celsius, 19.5); assert.equal(d1.meta.telemetry.relative_humidity_percent, 44); assert.equal(d1.meta.hopStart, 3);
  const user = toBinary(pb.Mesh.UserSchema, create(pb.Mesh.UserSchema, { longName: 'Base Camp', shortName: 'BC' }));
  assert.deepEqual(codec.decodeFromRadio(wrap(pb.Portnums.PortNum.NODEINFO_APP, user)).meta.user, { longName: 'Base Camp', shortName: 'BC' });
  const text = codec.decodeFromRadio(wrap(pb.Portnums.PortNum.TEXT_MESSAGE_APP, new TextEncoder().encode('secret words')));
  assert.equal(JSON.stringify(text).includes('secret words'), false);
  assert.equal(codec.decodeFromRadio(wrap(pb.Portnums.PortNum.TELEMETRY_APP, Uint8Array.of(0xff, 0xff))).meta.portnum, 'TELEMETRY_APP');
});

function request(port, pathname, { token, host, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}; if (token) headers.Authorization = `Bearer ${token}`; if (host) headers.Host = host;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject); req.end();
  });
}

test('local API: loopback only, token, rebinding guard, no sending', async () => {
  const h = hub({ localApi: { enabled: true, port: 9479 } }); for (const p of [INFO, TEXT, TELEM]) h.observe(p);
  const server = new I.LocalApiServer(h, 0, h.dataDir); const port = await server.start();
  try {
    assert.equal(server.httpd.address().address, '127.0.0.1');
    assert.equal(fs.statSync(path.join(h.dataDir, I.TOKEN_FILE)).mode & 0o777, 0o600);
    assert.equal(I.loadOrCreateToken(h.dataDir), server.token);
    assert.equal((await request(port, '/metrics')).status, 200);
    assert.equal((await request(port, '/metrics', { host: 'evil.example' })).status, 403);
    assert.equal((await request(port, '/api/nodes')).status, 401);
    const nodes = JSON.parse((await request(port, '/api/nodes', { token: server.token })).body).nodes;
    assert.equal(nodes[0].short_name, 'RT');
    const tel = JSON.parse((await request(port, '/api/telemetry?node=RT', { token: server.token })).body);
    assert.equal(tel.points[0].battery_percent, 87);
    assert.equal((await request(port, '/api/send', { token: server.token, method: 'POST' })).status, 405);
    assert.equal(JSON.parse((await request(port, '/api/status', { token: server.token })).body).integrations.assistant_send_enabled, false);
  } finally { await server.stop(); }
  assert.equal(I.hostIsLoopback('localhost:9479'), true); assert.equal(I.hostIsLoopback('[::1]:9479'), true); assert.equal(I.hostIsLoopback('127.0.0.1.evil.example'), false);
});

test('hub start/reload toggles the API', async () => {
  const h = hub({ localApi: { enabled: true, port: 0 } });
  h.settings.localApi.port = 0; await h.start(); assert.ok(h.server);
  await h.reload({}); assert.equal(h.server, null); await h.stop();
});

test('main process wires integrations without touching renderer security', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.equal((main.match(/watchSession\(next_session\)/g) || []).length, 3, 'TCP, USB and BLE sessions all feed integrations');
  assert.match(main, /label:'Integrations'/);
  const pkg = require('../package.json');
  for (const f of ['integrations.cjs', 'integrations-paths.cjs', 'assistant-mcp.cjs']) assert.ok(pkg.build.files.includes(f), f);
  const grafana = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'grafana', 'mesh-telemetry-dashboard.json'), 'utf8'));
  const exprs = grafana.panels.flatMap(p => (p.targets || []).map(t => t.expr)).join(' ');
  for (const m of ['mesh_node_battery_percent', 'mesh_node_temperature_celsius', 'mesh_nodes_heard_last_hour']) assert.ok(exprs.includes(m), m);
});
