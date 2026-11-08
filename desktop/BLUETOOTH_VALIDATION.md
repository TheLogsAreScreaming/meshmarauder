# Bluetooth validation gates

Bluetooth support is **not** production ready. The BLE transport requires a native adapter that is **not** bundled in the Intel Mac app. No UI claim of BLE connectivity is permitted until the hardware gates below pass on real macOS hardware.

## Software integration (done, behind the adapter seam)

The BLE path is now wired end-to-end in software so it will light up the moment a validated native adapter is installed — but it stays OFF until then:

- [x] Adapter loader seam (`ble-adapter.cjs`) — `createBleAdapter()` returns `null` (no bundled backend), so discovery/connect reject with an explicit "not installed" error.
- [x] Main-process IPC (`radio:ble-list`, `radio:ble-connect`) running the same bounded-retry + Meshtastic handshake pipeline as TCP/USB, proven by a fake-adapter handshake test (`ble-session-connect`).
- [x] Capability probe (`radio:capabilities` → `capabilities().bluetooth.available`) drives the UI; with no adapter it is `false`.
- [x] UI card ships **disabled** and labelled *Experimental*; no state claims connectivity.

## Hardware gates (required before any release claims BLE)

- [ ] Select and document a macOS BLE adapter/backend compatible with the Meshtastic GATT service, and wire it into `tryLoadNativeAdapter()`.
- [ ] Validate user-initiated discovery, explicit device selection, and permission prompts.
- [ ] Validate characteristic subscriptions, packet framing, handshake, and session-ready status.
- [ ] Confirm unexpected radio power loss, macOS Bluetooth toggles, and manual disconnect recover.
- [ ] Confirm no automatic transmission or invasive scanning; keep radio actions opt-in.
- [ ] Run the full Intel Mac workflow and record radio firmware, logs, and screenshots.

Do not merge BLE capability claims into a release until these hardware gates are verified.
