# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run Homebridge with debug mode using local config
npm run dev

# Run tests (Node.js native test runner)
npm test
```

No build or lint steps are configured. The project uses ES modules (`.mjs` files) and runs directly in Node.js 20.15.1+/22/24.

Tests in `test/` are integration-style and require real Tuya credentials configured in `test/env.js` (use `test/env.js` as a template).

## Architecture

This is a Homebridge plugin that bridges Tuya smart home devices into Apple HomeKit. It supports two protocol stacks in parallel: **HAP** (Homebridge 1.3+) and **Matter** (Homebridge 2.0+).

### Request/Data Flow

```
Homebridge startup
  → TuyaPlatform (src/platform.mjs)
      → TuyaOpenAPI or TuyaSHOpenAPI  (login, fetch device list)
      → creates HAP accessories (lib/accessories/hap/)
      → registers Matter accessories via TuyaMatterBridge (lib/matter_support.mjs)
      → TuyaOpenMQ (lib/tuyamqttapi.mjs)  starts MQTT listener
            ↓ real-time device state changes
      → routes MQTT messages to each accessory instance for state updates
```

### Key Modules

| File | Role |
|------|------|
| `src/platform.mjs` | Main orchestrator — lifecycle, device discovery, accessory creation, MQTT routing |
| `lib/tuyaopenapi.mjs` | Tuya Cloud REST client (Project Type 1) — HMAC-SHA256 signed requests, token refresh |
| `lib/tuyashopenapi.mjs` | Tuya SmartHome REST client (Project Type 2) |
| `lib/tuyamqttapi.mjs` | MQTT client — AES-GCM decryption of incoming messages, reconnection backoff |
| `lib/matter_support.mjs` | Matter bridge — device type resolution, accessory registration for Homebridge 2.0 |
| `lib/accessories/hap/base_accessory.mjs` | Base class for all HAP accessories — HAP service setup, `sendTuyaCommand()`, state caching |
| `lib/accessories/matter/_shared.mjs` | Shared Matter utilities — unit conversions, device identity, status code arrays |

### Accessory Architecture

Both `lib/accessories/hap/` and `lib/accessories/matter/` contain parallel implementations for each device type (switch, light, outlet, air_purifier, window_covering, fan, heater, garage_door, contact_sensor, motion_sensor, leak_sensor, smoke_sensor, valve, push).

All HAP accessories extend `BaseAccessory`. Registration is deliberately deferred via `process.nextTick()` so child constructors complete before the accessory registers with Homebridge.

### Device Type Mapping

`platform.mjs` maps Tuya device category strings to accessory classes:
- `"kj"` → AirPurifier, `"cz"/"pc"` → Outlet, `"dj"/"dd"` → Light, `"kg"/"tdq"` → Switch, etc.

Each device exposes a `status` array of `{ code, value }` objects. Accessory classes map specific codes (`switch`, `switch_1`, `bright_value`, `temp_value`, etc.) to HAP/Matter characteristics.

### Configuration

Project type is selected in Homebridge config:
- **Type 1** (Custom Cloud): `accessId` + `accessKey` + `endPoint` → uses `TuyaOpenAPI`
- **Type 2** (PaaS/SmartHome): `username` + `password` + `countryCode` + `appSchema` → uses `TuyaSHOpenAPI`

Device-level overrides (`valve`, `motion` timeout) and `ignoreDevices` list are configured in `config.schema.json`.
