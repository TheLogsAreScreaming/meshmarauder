# Integrations: webhooks, assistant link and sensor history

Mesh Marauder can share what its radio session hears with other software.
**Everything is off until you turn it on.** Mesh Marauder is a monitor, so two
limits apply everywhere:

* it **never decodes message text**: message events say who sent a text, when
  and on which channel, but not what it said;
* it **never transmits**: the assistant link has no send tool.

Telemetry readings (battery, voltage, temperature, humidity, pressure, channel
use) and public node names are decoded so they can be exported.

## Settings

Choose **Integrations → Open Integrations Settings…** in the menu bar. This
creates (if needed) and opens `integrations.json` in
`~/Library/Application Support/Mesh Marauder/integrations/`. After editing,
choose **Integrations → Reload Integrations Settings** (or restart the app).

```json
{
  "webhooks": {
    "enabled": false,
    "urls": [],
    "events": ["message", "node", "telemetry"],
    "secret": ""
  },
  "localApi": { "enabled": false, "port": 9479, "metrics": true },
  "influx": { "file": "", "url": "", "token": "" }
}
```

Only the literal value `true` turns a part on. Invalid URLs, unknown event
names and ports below 1024 are ignored.

## 1. Webhooks

```json
"webhooks": {
  "enabled": true,
  "urls": ["https://example.org/hooks/mesh", "http://127.0.0.1:1880/mesh"],
  "events": ["node", "telemetry"],
  "secret": "choose-a-long-random-string"
}
```

Each event is one `POST` (`Content-Type: application/json`):

```json
{"app": "mesh-marauder", "event": "telemetry",
 "data": {"node_id": "!1234abcd", "channel": 0, "time": 1700000000,
          "metrics": {"battery_percent": 87, "voltage_volts": 4.01, "temperature_celsius": 21.5}}}
```

* `node`: every packet heard (node id, name when known, SNR, RSSI, hops, packet type).
* `message`: a text message was heard (sender, recipient, direct or broadcast, channel). No text.
* `telemetry`: decoded readings in `data.metrics`.
* With a `secret`, every request carries `X-Mesh-Signature: sha256=<hex>`
  (HMAC-SHA256 of the raw body). `X-Mesh-Event` names the event.

Delivery happens in the background with a 5 second timeout and one retry; at
most 500 deliveries wait in the queue, extra ones are dropped and counted.

## 2. Assistant link (MCP)

1. Set `"localApi": { "enabled": true, "port": 9479 }` and reload. The app
   starts a small server on `127.0.0.1:9479` (never on your network) and writes
   a random access token to `assistant-token` in the same folder (readable only
   by you).

2. Add the server to Claude Desktop (**Settings → Developer → Edit Config**):

   ```json
   {
     "mcpServers": {
       "mesh-marauder": {
         "command": "/Applications/Mesh Marauder.app/Contents/MacOS/Mesh Marauder",
         "args": ["/Applications/Mesh Marauder.app/Contents/Resources/app.asar/assistant-mcp.cjs"],
         "env": { "ELECTRON_RUN_AS_NODE": "1" }
       }
     }
   }
   ```

   `ELECTRON_RUN_AS_NODE=1` runs the app's built-in Node.js instead of opening a
   window. From a source checkout with Node.js 22 you can instead use
   `"command": "node", "args": ["/path/to/meshmarauder/desktop/assistant-mcp.cjs"]`.
   For Claude Code:
   `claude mcp add mesh-marauder -e ELECTRON_RUN_AS_NODE=1 -- "/Applications/Mesh Marauder.app/Contents/MacOS/Mesh Marauder" "/Applications/Mesh Marauder.app/Contents/Resources/app.asar/assistant-mcp.cjs"`.

3. Restart Claude Desktop, keep Mesh Marauder connected to a radio, and ask
   e.g. *"Which nodes reported low battery today?"*

| Tool | What it returns |
| --- | --- |
| `get_network_status` | session state, nodes known / heard in the last hour, packets by type, integration status |
| `list_nodes` | nodes heard, most recent first, with names, SNR/RSSI, hops and latest telemetry |
| `recent_messages` | text-message activity (sender, time, channel); never the text |
| `node_telemetry` | telemetry history for one node (id, short or long name) |

All tools are read-only. There is deliberately no send tool.

The app keeps the last 200 message events and 500 telemetry points per node
in memory; they are cleared when the app quits.

## 3. Sensor history: Prometheus, InfluxDB, Grafana

With the local API on (and `"metrics": true`):

* `http://127.0.0.1:9479/metrics`: Prometheus text format: `mesh_radio_connected`,
  `mesh_nodes_known`, `mesh_nodes_heard_last_hour`, `mesh_packets_total{portnum}`,
  and per node (`node`, `name` labels) `mesh_node_last_heard_timestamp_seconds`,
  `mesh_node_snr`, `mesh_node_rssi`, `mesh_node_battery_percent`,
  `mesh_node_voltage_volts`, `mesh_node_temperature_celsius`,
  `mesh_node_relative_humidity_percent`, `mesh_node_barometric_pressure_hpa`,
  `mesh_node_channel_utilization_percent` and more.
* `http://127.0.0.1:9479/influx`: everything in memory as InfluxDB line protocol.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: mesh-marauder
    scrape_interval: 60s
    static_configs:
      - targets: ["127.0.0.1:9479"]
```

InfluxDB without Prometheus:

* `"influx": {"file": "telemetry.lp"}` appends each telemetry packet to
  `telemetry.lp` in the integrations folder (`influx write --precision s --file telemetry.lp`).
* `"influx": {"url": "http://127.0.0.1:8086/api/v2/write?org=home&bucket=mesh&precision=s", "token": "..."}`
  pushes each line to InfluxDB v2.

Line format: `mesh_telemetry,node=!1234abcd,name=Ridge\ Top battery_percent=87.0,voltage_volts=4.01 1700000000`.

**Grafana:** import [`grafana/mesh-telemetry-dashboard.json`](grafana/mesh-telemetry-dashboard.json)
(**Dashboards → New → Import**) and pick your Prometheus data source.

## Security notes

* The server listens on `127.0.0.1` only and refuses requests whose `Host`
  header is not a loopback name (protects against DNS rebinding from web pages).
* `/metrics`, `/influx` and `/healthz` need no token so local Prometheus can
  scrape them; `/api/*` needs the token. Delete `assistant-token` to rotate it.
* Webhook bodies contain node ids and names; use `https://` for anything off
  this Mac.
