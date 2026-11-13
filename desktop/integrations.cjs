'use strict';
// Optional integrations for Mesh Marauder: webhooks, a localhost-only API used
// by the assistant link (MCP), Prometheus /metrics and InfluxDB line protocol.
// Everything is OFF until switched on in integrations.json (see
// INTEGRATIONS.md). Mesh Marauder is a monitor: it never decodes message text
// and never transmits, so message events are metadata only and there is no
// send tool.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');

const EVENT_TYPES = ['message', 'node', 'telemetry'];
const DEFAULT_PORT = 9479;
const MAX_MESSAGES = 200;
const MAX_TELEMETRY_PER_NODE = 500;
const MAX_NODES = 2000;
const TOKEN_FILE = 'assistant-token';
const SETTINGS_FILE = 'integrations.json';
const USER_AGENT = 'mesh-marauder-integrations/1';

const DEFAULT_SETTINGS = Object.freeze({
  webhooks: { enabled: false, urls: [], events: EVENT_TYPES.slice(), secret: '' },
  localApi: { enabled: false, port: DEFAULT_PORT, metrics: true },
  influx: { file: '', url: '', token: '' },
});

function validUrl(url) {
  if (typeof url !== 'string' || /\s/.test(url)) return false;
  try { const u = new URL(url); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host; } catch { return false; }
}

function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = r.webhooks && typeof r.webhooks === 'object' ? r.webhooks : {};
  const a = r.localApi && typeof r.localApi === 'object' ? r.localApi : {};
  const i = r.influx && typeof r.influx === 'object' ? r.influx : {};
  const port = Number.isInteger(a.port) && a.port >= 1024 && a.port <= 65535 ? a.port : DEFAULT_PORT;
  const events = Array.isArray(w.events) ? w.events.filter(e => EVENT_TYPES.includes(e)) : EVENT_TYPES.slice();
  return {
    webhooks: { enabled: w.enabled === true, urls: (Array.isArray(w.urls) ? w.urls : []).filter(validUrl), events, secret: typeof w.secret === 'string' ? w.secret : '' },
    localApi: { enabled: a.enabled === true, port, metrics: a.metrics !== false },
    influx: { file: typeof i.file === 'string' ? i.file.trim() : '', url: validUrl(i.url) ? i.url : '', token: typeof i.token === 'string' ? i.token : '' },
  };
}

function loadSettings(dir) {
  const file = path.join(dir, SETTINGS_FILE);
  try { return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return normalizeSettings(DEFAULT_SETTINGS); }
}

function ensureSettingsFile(dir) {
  const file = path.join(dir, SETTINGS_FILE);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n', { mode: 0o600 });
  }
  return file;
}

const nodeId = num => '!' + ((Number(num) >>> 0).toString(16).padStart(8, '0'));
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Session 'message' objects -> [kind, payload] events.
function normalizeMessage(message, now = Date.now() / 1000) {
  if (!message || message.variant !== 'packet' || !message.meta || typeof message.meta !== 'object') return [];
  const m = message.meta;
  if (!Number.isSafeInteger(m.from) || m.from <= 0 || m.from > 0xffffffff) return [];
  const id = nodeId(m.from);
  const time = Number.isInteger(m.rxTime) && m.rxTime > 0 ? m.rxTime : Math.floor(now);
  const channel = Number.isInteger(m.channel) ? m.channel : 0;
  const hops = Number.isInteger(m.hopStart) && Number.isInteger(m.hopLimit) && m.hopStart >= m.hopLimit && m.hopStart > 0 ? m.hopStart - m.hopLimit : null;
  const seen = { node_id: id, time, channel, portnum: m.encrypted ? 'ENCRYPTED' : String(m.portnum || 'UNKNOWN'), snr: finite(m.rxSnr), rssi: finite(m.rxRssi), hops_away: hops };
  if (m.user && typeof m.user === 'object') {
    if (m.user.longName) seen.long_name = String(m.user.longName).slice(0, 40);
    if (m.user.shortName) seen.short_name = String(m.user.shortName).slice(0, 8);
  }
  const events = [['node', seen]];
  if (m.portnum === 'TEXT_MESSAGE_APP') {
    events.push(['message', { node_id: id, time, channel, to: nodeId(m.to), direct: Number.isInteger(m.to) && (m.to >>> 0) !== 0xffffffff, snr: seen.snr, rssi: seen.rssi }]);
  }
  if (m.telemetry && typeof m.telemetry === 'object') {
    const metrics = {};
    for (const [k, v] of Object.entries(m.telemetry)) if (finite(v) !== null) metrics[k] = v;
    if (Object.keys(metrics).length) events.push(['telemetry', { node_id: id, time, channel, metrics }]);
  }
  return events;
}

class MeshState {
  constructor(clock = () => Date.now() / 1000) {
    this.clock = clock; this.started = clock(); this.nodes = new Map(); this.messages = []; this.telemetry = new Map();
    this.packetsByPort = {}; this.radio = { connected: false };
  }
  apply(kind, p) {
    if (kind === 'node') {
      this.packetsByPort[p.portnum] = (this.packetsByPort[p.portnum] || 0) + 1;
      let node = this.nodes.get(p.node_id);
      if (!node) { node = { node_id: p.node_id, first_heard: p.time, packets: 0 }; this.nodes.set(p.node_id, node); }
      node.packets += 1; node.last_heard = p.time;
      for (const k of ['snr', 'rssi', 'hops_away', 'long_name', 'short_name']) if (p[k] !== null && p[k] !== undefined && p[k] !== '') node[k] = p[k];
      if (this.nodes.size > MAX_NODES) {
        let oldest = null; for (const n of this.nodes.values()) if (!oldest || (n.last_heard || 0) < (oldest.last_heard || 0)) oldest = n;
        this.nodes.delete(oldest.node_id);
      }
    } else if (kind === 'message') {
      this.messages.push({ ...p }); if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    } else if (kind === 'telemetry') {
      let series = this.telemetry.get(p.node_id); if (!series) { series = []; this.telemetry.set(p.node_id, series); }
      series.push({ time: p.time, ...p.metrics }); if (series.length > MAX_TELEMETRY_PER_NODE) series.shift();
      let node = this.nodes.get(p.node_id);
      if (!node) { node = { node_id: p.node_id, first_heard: p.time, packets: 0 }; this.nodes.set(p.node_id, node); }
      node.telemetry = { ...(node.telemetry || {}), ...p.metrics };
    }
  }
  nodeName(id) { const n = this.nodes.get(id) || {}; return n.long_name || n.short_name || id; }
  listNodes(limit = 100) {
    return [...this.nodes.values()].sort((a, b) => (b.last_heard || 0) - (a.last_heard || 0)).slice(0, Math.max(1, Math.min(limit, MAX_NODES))).map(n => JSON.parse(JSON.stringify(n)));
  }
  recentMessages(limit = 20, channel = null) {
    const items = this.messages.filter(m => channel === null || m.channel === channel);
    return items.slice(-Math.max(1, Math.min(limit, MAX_MESSAGES))).map(m => ({ ...m, from_name: this.nodeName(m.node_id) }));
  }
  findNode(query) {
    const q = String(query || '').trim().toLowerCase(); if (!q) return null;
    for (const [id, n] of this.nodes) {
      if ([id.toLowerCase(), id.toLowerCase().replace(/^!/, ''), String(n.short_name || '').toLowerCase(), String(n.long_name || '').toLowerCase()].includes(q)) return id;
    }
    return null;
  }
  nodeTelemetry(id, limit = 50) { return (this.telemetry.get(id) || []).slice(-Math.max(1, Math.min(limit, MAX_TELEMETRY_PER_NODE))).map(p => ({ ...p })); }
  status() {
    const now = this.clock(); let active = 0;
    for (const n of this.nodes.values()) if (now - (n.last_heard || 0) <= 3600) active += 1;
    const total = Object.values(this.packetsByPort).reduce((a, b) => a + b, 0);
    return { radio: { ...this.radio }, uptime_seconds: Math.floor(now - this.started), nodes_known: this.nodes.size, nodes_heard_last_hour: active, messages_buffered: this.messages.length, packets_total: total, packets_by_port: { ...this.packetsByPort }, message_text: 'not decoded (monitor only)' };
  }
}

const promLabel = v => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const num = v => (Number.isInteger(v) ? String(v) : String(Number(v)));

function renderPrometheus(state, prefix = 'mesh') {
  const s = state.status();
  const lines = [
    `# HELP ${prefix}_up 1 while the app is running.`, `# TYPE ${prefix}_up gauge`, `${prefix}_up 1`,
    `# HELP ${prefix}_radio_connected 1 when the radio session is ready.`, `# TYPE ${prefix}_radio_connected gauge`, `${prefix}_radio_connected ${s.radio.connected ? 1 : 0}`,
    `# TYPE ${prefix}_nodes_known gauge`, `${prefix}_nodes_known ${s.nodes_known}`,
    `# TYPE ${prefix}_nodes_heard_last_hour gauge`, `${prefix}_nodes_heard_last_hour ${s.nodes_heard_last_hour}`,
    `# TYPE ${prefix}_packets_total counter`,
  ];
  for (const port of Object.keys(s.packets_by_port).sort()) lines.push(`${prefix}_packets_total{portnum="${promLabel(port)}"} ${s.packets_by_port[port]}`);
  const perMetric = new Map();
  const add = (metric, sample) => { if (!perMetric.has(metric)) perMetric.set(metric, []); perMetric.get(metric).push(sample); };
  for (const n of state.listNodes(MAX_NODES)) {
    const labels = `node="${promLabel(n.node_id)}",name="${promLabel(n.long_name || n.short_name || '')}"`;
    if (n.last_heard) add('node_last_heard_timestamp_seconds', `{${labels}} ${Math.floor(n.last_heard)}`);
    for (const k of ['snr', 'rssi']) if (typeof n[k] === 'number') add(`node_${k}`, `{${labels}} ${num(n[k])}`);
    for (const k of Object.keys(n.telemetry || {}).sort()) add(`node_${k}`, `{${labels}} ${num(n.telemetry[k])}`);
  }
  for (const metric of [...perMetric.keys()].sort()) {
    lines.push(`# TYPE ${prefix}_${metric} gauge`);
    for (const sample of perMetric.get(metric)) lines.push(`${prefix}_${metric}${sample}`);
  }
  return lines.join('\n') + '\n';
}

const influxEscape = v => String(v).replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/=/g, '\\=').replace(/ /g, '\\ ').replace(/\n/g, '\\n');
const influxFloat = v => (Number.isInteger(v) ? `${v}.0` : String(v));

function influxLine(id, metrics, timestamp, name = '', measurement = 'mesh_telemetry') {
  const fields = Object.keys(metrics).sort().filter(k => finite(metrics[k]) !== null).map(k => `${influxEscape(k)}=${influxFloat(metrics[k])}`);
  if (!fields.length) return '';
  const tags = `node=${influxEscape(id)}` + (name ? `,name=${influxEscape(name)}` : '');
  return `${measurement},${tags} ${fields.join(',')} ${Math.floor(timestamp)}`;
}

function exportInflux(state) {
  const out = [];
  for (const id of [...state.telemetry.keys()].sort()) {
    const name = state.nodeName(id) === id ? '' : state.nodeName(id);
    for (const point of state.telemetry.get(id)) {
      const { time, ...metrics } = point; const line = influxLine(id, metrics, time, name); if (line) out.push(line);
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

async function defaultPost(url, body, headers, timeoutMs) {
  const response = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  return response.status;
}

class Deliverer {
  constructor({ post = defaultPost, maxQueue = 500, timeoutMs = 5000, retries = 1, retryDelayMs = 2000 } = {}) {
    Object.assign(this, { post, maxQueue, timeoutMs, retries, retryDelayMs });
    this.queue = []; this.running = false; this.stopped = false; this.idle = Promise.resolve();
    this.stats = { sent: 0, failed: 0, dropped: 0, last_error: '' };
  }
  submit(url, body, headers) {
    if (this.stopped) return;
    if (this.queue.length >= this.maxQueue) { this.stats.dropped += 1; return; }
    this.queue.push({ url, body, headers });
    if (!this.running) this.idle = this.drain();
  }
  async drain() {
    this.running = true;
    try { while (this.queue.length && !this.stopped) { const item = this.queue.shift(); await this.deliverNow(item.url, item.body, item.headers); } }
    finally { this.running = false; }
  }
  async deliverNow(url, body, headers) {
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      let error;
      try { const status = await this.post(url, body, headers, this.timeoutMs); if (status >= 200 && status < 300) { this.stats.sent += 1; return true; } error = `HTTP ${status}`; }
      catch (e) { error = (e && e.name) || 'Error'; }
      let host = ''; try { host = new URL(url).host; } catch {}
      this.stats.last_error = `${host}: ${error}`;
      if (attempt < this.retries && this.retryDelayMs) await new Promise(r => setTimeout(r, this.retryDelayMs).unref?.());
    }
    this.stats.failed += 1; return false;
  }
  stop() { this.stopped = true; this.queue = []; }
}

class IntegrationHub {
  constructor({ settings, dataDir, deliverer, clock, appName = 'mesh-marauder' } = {}) {
    this.settings = normalizeSettings(settings || DEFAULT_SETTINGS);
    this.dataDir = dataDir || process.cwd(); this.appName = appName;
    this.state = new MeshState(clock); this.deliverer = deliverer || new Deliverer(); this.server = null;
  }
  observe(message) {
    try {
      const events = normalizeMessage(message);
      for (const [kind, payload] of events) { this.state.apply(kind, payload); this.fanOut(kind, payload); }
      return events;
    } catch { return []; }
  }
  setRadio(info) { Object.assign(this.state.radio, info); }
  fanOut(kind, payload) {
    const w = this.settings.webhooks;
    if (w.enabled && w.urls.length && w.events.includes(kind)) {
      const data = { ...payload }; if (kind === 'node') data.name = this.state.nodeName(payload.node_id);
      const body = JSON.stringify({ app: this.appName, event: kind, data });
      const headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'X-Mesh-Event': kind };
      if (w.secret) headers['X-Mesh-Signature'] = sign(w.secret, body);
      for (const url of w.urls) this.deliverer.submit(url, body, headers);
    }
    const i = this.settings.influx;
    if (kind === 'telemetry' && (i.file || i.url)) {
      const name = this.state.nodeName(payload.node_id);
      const line = influxLine(payload.node_id, payload.metrics, payload.time, name === payload.node_id ? '' : name);
      if (!line) return;
      if (i.file) {
        let file = i.file.startsWith('~/') ? path.join(require('node:os').homedir(), i.file.slice(2)) : i.file;
        if (!path.isAbsolute(file)) file = path.join(this.dataDir, file);
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, line + '\n'); } catch {}
      }
      if (i.url) {
        const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'User-Agent': USER_AGENT };
        if (i.token) headers.Authorization = `Token ${i.token}`;
        this.deliverer.submit(i.url, line + '\n', headers);
      }
    }
  }
  describe() {
    const s = this.settings;
    return { webhooks: { enabled: s.webhooks.enabled, endpoints: s.webhooks.urls.length, events: s.webhooks.events.slice().sort(), ...this.deliverer.stats },
      local_api: { enabled: s.localApi.enabled, port: s.localApi.port, metrics: s.localApi.enabled && s.localApi.metrics },
      assistant_send_enabled: false, influx: { file: !!s.influx.file, push: !!s.influx.url } };
  }
  async start() {
    if (this.settings.localApi.enabled && !this.server) {
      this.server = new LocalApiServer(this, this.settings.localApi.port, this.dataDir);
      await this.server.start();
    }
  }
  async stop() { if (this.server) { await this.server.stop(); this.server = null; } this.deliverer.stop(); }
  async reload(settings) {
    const wasPort = this.settings.localApi.port; const wasOn = this.settings.localApi.enabled;
    this.settings = normalizeSettings(settings);
    if (this.server && (!this.settings.localApi.enabled || this.settings.localApi.port !== wasPort || !wasOn)) { await this.server.stop(); this.server = null; }
    if (this.deliverer.stopped) this.deliverer = new Deliverer();
    await this.start();
  }
}

function loadOrCreateToken(dir) {
  const file = path.join(dir, TOKEN_FILE);
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (t.length >= 32) return t; } catch {}
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 }); fs.chmodSync(file, 0o600);
  return token;
}

function hostIsLoopback(header) {
  if (!header) return false;
  let host = String(header).trim().toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else if ((host.match(/:/g) || []).length === 1) host = host.split(':')[0];
  if (host === 'localhost') return true;
  if (net.isIPv4(host)) return host.startsWith('127.');
  return host === '::1';
}

class LocalApiServer {
  constructor(hub, port, dataDir) {
    this.hub = hub; this.requestedPort = port; this.token = loadOrCreateToken(dataDir);
    this.httpd = http.createServer((req, res) => this.handle(req, res));
  }
  start() { return new Promise((resolve, reject) => { this.httpd.once('error', reject); this.httpd.listen(this.requestedPort, '127.0.0.1', () => { this.port = this.httpd.address().port; resolve(this.port); }); }); }
  stop() { return new Promise(resolve => { this.httpd.closeAllConnections?.(); this.httpd.close(() => resolve()); }); }
  reply(res, status, body, type = 'application/json') {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
    res.end(data);
  }
  handle(req, res) {
    const hub = this.hub;
    if (!hostIsLoopback(req.headers.host)) return this.reply(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const qint = (name, d) => { const v = parseInt(url.searchParams.get(name), 10); return Number.isFinite(v) ? v : d; };
    if (req.method === 'GET' && url.pathname === '/healthz') return this.reply(res, 200, { ok: true });
    if (req.method === 'GET' && (url.pathname === '/metrics' || url.pathname === '/influx')) {
      if (!hub.settings.localApi.metrics) return this.reply(res, 404, { error: 'metrics disabled' });
      return url.pathname === '/metrics'
        ? this.reply(res, 200, renderPrometheus(hub.state), 'text/plain; version=0.0.4; charset=utf-8')
        : this.reply(res, 200, exportInflux(hub.state), 'text/plain; charset=utf-8');
    }
    if (!url.pathname.startsWith('/api/')) return this.reply(res, 404, { error: 'not found' });
    const supplied = Buffer.from(String(req.headers.authorization || '')); const expected = Buffer.from(`Bearer ${this.token}`);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return this.reply(res, 401, { error: 'missing or wrong token' });
    if (req.method !== 'GET') return this.reply(res, 405, { error: 'Mesh Marauder is a monitor and cannot send messages' });
    if (url.pathname === '/api/status') return this.reply(res, 200, { app: hub.appName, ...hub.state.status(), integrations: hub.describe() });
    if (url.pathname === '/api/nodes') return this.reply(res, 200, { nodes: hub.state.listNodes(qint('limit', 50)) });
    if (url.pathname === '/api/messages') {
      const ch = url.searchParams.get('channel'); const channel = ch !== null && /^\d+$/.test(ch) ? Number(ch) : null;
      return this.reply(res, 200, { messages: hub.state.recentMessages(qint('limit', 20), channel), note: 'Mesh Marauder records who sent text and when; it never decodes message text.' });
    }
    if (url.pathname === '/api/telemetry') {
      const id = hub.state.findNode(url.searchParams.get('node'));
      if (!id) return this.reply(res, 404, { error: 'unknown node' });
      return this.reply(res, 200, { node_id: id, name: hub.state.nodeName(id), points: hub.state.nodeTelemetry(id, qint('limit', 50)) });
    }
    return this.reply(res, 404, { error: 'not found' });
  }
}

module.exports = {
  EVENT_TYPES, DEFAULT_PORT, DEFAULT_SETTINGS, SETTINGS_FILE, TOKEN_FILE,
  normalizeSettings, loadSettings, ensureSettingsFile, normalizeMessage, MeshState, renderPrometheus,
  influxLine, exportInflux, sign, Deliverer, IntegrationHub, LocalApiServer, loadOrCreateToken, hostIsLoopback,
};
