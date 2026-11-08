'use strict';
// Optional native BLE backend loader.
//
// Mesh Marauder's BleTransport talks to a small adapter contract
// ({ list, connect, send, disconnect }) so the Meshtastic session pipeline is
// transport-agnostic. No native macOS BLE backend is bundled with the Intel Mac
// app yet (see BLUETOOTH_VALIDATION.md), so this loader returns null by default.
// When adapter is null, BleTransport.list()/connect() reject with an explicit
// "not installed" error and the UI keeps every Bluetooth control disabled — the
// app never claims BLE connectivity it cannot deliver.
//
// To light BLE up later: provide a backend here that implements the contract
// against a validated native module, and the whole pipeline (discovery →
// connect → handshake → packets) that is already wired for TCP/USB begins to
// work for Bluetooth with no further changes.
//
// `load` is injectable so tests can supply a backend without a native module.
function createBleAdapter({ load = tryLoadNativeAdapter } = {}) {
  const adapter = load();
  return adapter || null;
}

// Intentionally returns null until a validated backend is wired in. Kept as a
// seam (rather than inlined) so the loading decision has one obvious home.
function tryLoadNativeAdapter() {
  return null;
}

module.exports = { createBleAdapter, tryLoadNativeAdapter };
