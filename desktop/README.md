# Mesh Marauder Desktop (rebuild)

The desktop application is a new, isolated interface for **authorized Meshtastic radio monitoring**. It builds on the upstream GPL-3.0 codebase while preserving the original command-line tools and copyright notices.

## Integrations (optional, off by default)

Webhooks for node / message-activity / telemetry events, a read-only assistant link for Claude (MCP), Prometheus `/metrics`, InfluxDB line protocol and a Grafana dashboard. Message text is never decoded and nothing is transmitted. See [INTEGRATIONS.md](INTEGRATIONS.md).

## Targets
- Intel x86_64 macOS Tahoe 26.7.1, click-to-open Electron app in DMG and ZIP
- Wi-Fi/TCP, BLE, and USB/serial transports with Meshtastic session checks
- Clear demonstration mode, operator-safe connections, diagnostics, packet monitor
- Four themes: Futuristic Neons, Mocha Mousse, Fun & Vibrant, Dusk

## Implementation order
1. Desktop shell and deterministic demo mode
2. Transport interfaces and protocol validation
3. Real radio connection workflows and device discovery
4. Packet decoding and diagnostics
5. Automated Intel Mac packaging and release verification

> **Important:** A connected socket or serial port is not evidence of a successful Meshtastic session. Show session readiness only after protocol handshake completes.

This directory is kept independent of upstream command-line scripts. Keep GPL attribution and avoid automatically activating invasive/security-testing functions.

## Intel Mac verification (development build)

The desktop is experimental. Green CI does not establish that a physical Meshtastic radio was tested.

1. Download the Intel Mac workflow artifact (DMG or ZIP), not a release.
2. Open the app on an Intel x86_64 Mac and connect to an authorized Meshtastic radio over TCP (default port 4403).
3. Verify socket-open and Meshtastic session-ready are separate states.
4. Check LIVE packets against radio traffic; demonstration packets must be labeled DEMO / SIMULATED.
5. Disconnect the radio unexpectedly and confirm the Connect button recovers; reconnect manually.
6. Record macOS version, radio firmware, screenshots and errors.

### Remaining release gates

- Verify real radio handshake and reconnect behavior.
- Integrate native BLE and USB desktop controls, or explicitly label unsupported transports.
- Validate packet inspection and safe handling of private information.
- Audit bundled dependencies, GPL-3.0 attribution, signing and notarization.
- Obtain explicit release approval; do not publish from development PRs.

## Operator verification checklist (Intel Mac)

The GitHub Actions desktop workflow runs automated checks and packages Intel x86_64 DMG/ZIP artifacts. It may also upload an actual Electron screenshot under `mesh-marauder-ui-screenshot`. A screenshot is a UI smoke-check, **not** proof that a radio connected.

### TCP and USB acceptance checks

- [ ] Launch the downloaded development build on a real Intel Mac; note macOS version.
- [ ] Verify Wi-Fi/TCP host and port inputs accept a reachable authorized radio (default 4403).
- [ ] Confirm the UI distinguishes transport-open from Meshtastic session-ready.
- [ ] Confirm actual radio traffic appears as LIVE; demo entries remain DEMO / SIMULATED.
- [ ] Check observed nodes and signal readings against received packet metadata; missing RSSI/SNR should display N/A.
- [ ] Unplug or disconnect the radio, observe the diagnostic message, and verify manual reconnect works.
- [ ] Test USB device discovery, connection, disconnect, and recovery on a supported serial radio.
- [ ] Verify packet source filtering, counters and Clear work without leaking demo data into node observations.
- [ ] Capture screenshots showing the overview, diagnostics and node list, removing any private node identifiers before publishing.

### Screenshot publication policy

1. Download the screenshot artifact from a successful Intel Mac Actions run, if capture succeeded.
2. Inspect the PNG visually and confirm it shows the actual current app UI, not a blank window or an old version.
3. Only then commit an approved screenshot under `docs/screenshots/` and reference that checked-in image from the root README.
4. Do not present demonstration packet contents as actual radio traffic.

A green build, valid screenshot and automated tests do not replace the physical radio acceptance checks above.

## Release candidate decision record

**Current status: development builds only.** A passing workflow and an Intel DMG/ZIP artifact do not establish a signed, notarized or hardware-tested release.

| Gate | Evidence required | Current status |
| --- | --- | --- |
| Automated desktop tests | Green Intel Mac Actions run for the exact candidate commit | Verify on candidate |
| Intel packaging | x86_64 executable and both DMG/ZIP artifacts | Verify on candidate |
| TCP radio handshake | Physical radio connects, configuration completes and LIVE packets arrive | Not verified |
| Connection recovery | Unplug/disconnect, reconnect and clean quit without forced termination | Not verified |
| USB transport | Real serial radio handshake and disconnect | Not verified |
| BLE | Integrated and tested, or explicitly excluded from candidate scope | Not integrated |
| Screenshot | Visually inspected screenshot from candidate build | Not verified |
| Distribution | Signing/notarization decision and GPL attribution audit | Not verified |

### Candidate handoff

Record the exact Git commit SHA, macOS version, Meshtastic firmware, transport, screenshots and any errors when testing. Never publish a release automatically from pull-request workflows. The owner must explicitly approve publishing a candidate after checking the gates above.
