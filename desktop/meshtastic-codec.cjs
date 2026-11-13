'use strict';
// Real Meshtastic protobuf codec for the desktop client.
//
// @bufbuild/protobuf and @meshtastic/protobufs are ESM-only packages, so this
// CommonJS module loads them through a one-time dynamic import() and hands back
// a codec shaped exactly like the mock in meshtastic-session.test.cjs:
//   encodeWantConfig(nonce) -> Buffer   (a serialized ToRadio.want_config_id)
//   decodeFromRadio(bytes)  -> object   (always carries configCompleteId when
//                                         the radio reports the handshake done)
let loader = null;
function loadProtobufs() {
  if (!loader) {
    loader = Promise.all([
      import('@bufbuild/protobuf'),
      import('@meshtastic/protobufs'),
    ]).then(([buf, protobufs]) => ({
      fromBinary: buf.fromBinary,
      toBinary: buf.toBinary,
      create: buf.create,
      protobufs,
    }));
  }
  return loader;
}

function portName(protobufs, portnum) {
  const name = protobufs.Portnums && protobufs.Portnums.PortNum
    ? protobufs.Portnums.PortNum[portnum]
    : undefined;
  return typeof name === 'string' ? name : `PORT_${portnum >>> 0}`;
}

// Telemetry readings kept for integrations (Prometheus/InfluxDB/webhooks).
// Same metric names as the other desktop apps so one Grafana dashboard fits all.
const TELEMETRY_FIELDS = {
  deviceMetrics: { batteryLevel: 'battery_percent', voltage: 'voltage_volts', channelUtilization: 'channel_utilization_percent', airUtilTx: 'air_util_tx_percent', uptimeSeconds: 'uptime_seconds' },
  environmentMetrics: { temperature: 'temperature_celsius', relativeHumidity: 'relative_humidity_percent', barometricPressure: 'barometric_pressure_hpa', gasResistance: 'gas_resistance_ohms', iaq: 'iaq', lux: 'lux', windSpeed: 'wind_speed_mps', windDirection: 'wind_direction_degrees', rainfall1h: 'rainfall_1h_mm' },
  powerMetrics: { ch1Voltage: 'ch1_voltage_volts', ch1Current: 'ch1_current_ma' },
};

function telemetryValues(variant) {
  const out = {};
  const fields = variant && TELEMETRY_FIELDS[variant.case];
  if (!fields || !variant.value) return out;
  for (const [key, name] of Object.entries(fields)) {
    const value = variant.value[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
  }
  return out;
}

// Decode only telemetry readings and public node names. Message text is never
// decoded: this app is a monitor and keeps message content out of view.
function decodeExtras(fromBinary, protobufs, port, payload, meta) {
  if (!(payload instanceof Uint8Array) || payload.length === 0) return;
  try {
    if (port === 'TELEMETRY_APP') {
      const telemetry = fromBinary(protobufs.Telemetry.TelemetrySchema, payload);
      const values = telemetryValues(telemetry.variant);
      if (Object.keys(values).length) meta.telemetry = values;
    } else if (port === 'NODEINFO_APP') {
      const user = fromBinary(protobufs.Mesh.UserSchema, payload);
      meta.user = { longName: String(user.longName || '').slice(0, 40), shortName: String(user.shortName || '').slice(0, 8) };
    }
  } catch (_error) {
    // Undecodable payloads stay metadata-only.
  }
}

function describePacket(protobufs, packet, fromBinary) {
  const from = (packet.from >>> 0).toString(16);
  const to = (packet.to >>> 0).toString(16);
  const channel = packet.channel >>> 0;
  const meta = {
    from: packet.from >>> 0,
    to: packet.to >>> 0,
    channel,
    id: packet.id >>> 0,
    rxTime: packet.rxTime >>> 0,
    rxSnr: packet.rxSnr,
    rxRssi: packet.rxRssi,
    hopLimit: packet.hopLimit >>> 0,
    hopStart: packet.hopStart >>> 0,
  };
  const inner = packet.payloadVariant;
  if (inner && inner.case === 'decoded') {
    const port = portName(protobufs, inner.value.portnum);
    meta.encrypted = false;
    meta.portnum = port;
    if (fromBinary) decodeExtras(fromBinary, protobufs, port, inner.value.payload, meta);
    return { meta, summary: `pkt ${from}->${to} ch${channel} ${port}` };
  }
  meta.encrypted = true;
  return { meta, summary: `pkt ${from}->${to} ch${channel} encrypted` };
}

async function createMeshtasticCodec() {
  const { fromBinary, toBinary, create, protobufs } = await loadProtobufs();
  const ToRadioSchema = protobufs.Mesh.ToRadioSchema;
  const FromRadioSchema = protobufs.Mesh.FromRadioSchema;
  return {
    encodeWantConfig(nonce) {
      const id = nonce >>> 0;
      if (id === 0) throw new RangeError('want_config id must be non-zero');
      const message = create(ToRadioSchema, {
        payloadVariant: { case: 'wantConfigId', value: id },
      });
      return Buffer.from(toBinary(ToRadioSchema, message));
    },
    decodeFromRadio(bytes) {
      const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      const message = fromBinary(FromRadioSchema, input);
      const variant = message.payloadVariant;
      const out = { variant: (variant && variant.case) || 'unknown' };
      if (variant && variant.case === 'configCompleteId') {
        out.configCompleteId = variant.value >>> 0;
        out.summary = 'config-complete';
      } else if (variant && variant.case === 'packet') {
        const described = describePacket(protobufs, variant.value, fromBinary);
        out.meta = described.meta;
        out.summary = described.summary;
      } else if (variant && variant.case === 'myInfo') {
        out.summary = `my-info node ${(variant.value.myNodeNum >>> 0).toString(16)}`;
      } else if (variant && variant.case === 'nodeInfo') {
        out.summary = `node-info ${(variant.value.num >>> 0).toString(16)}`;
      } else {
        out.summary = out.variant;
      }
      return out;
    },
  };
}

module.exports = { createMeshtasticCodec, telemetryValues, TELEMETRY_FIELDS };
