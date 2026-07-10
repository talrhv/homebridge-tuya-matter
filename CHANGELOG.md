# Changelog

All notable changes to this project are documented in this file.

## 1.1.0-beta3

### Added — Republish device updates to a local MQTT broker

- **New "Republish to MQTT broker" option.** The plugin can now forward the real-time
  device updates it already receives from the Tuya cloud to your own local MQTT broker
  (e.g. [homebridge-aedes](https://www.npmjs.com/package/homebridge-aedes) or Mosquitto),
  so any app on your network can consume them — for example, feeding a live temperature
  reading from a Tuya sensor into another Homebridge accessory such as the Broadlink RM
  plugin's AC.
- **Opt-in and scoped by design.** The publisher acts purely as an MQTT *client* (it does
  not host a broker) and is **off by default**. It only starts when it is enabled **and**
  at least one device ID is listed in the allowlist — no broker connection is attempted
  otherwise. Configure it under the new **`mqttPublish`** section: `enabled`, broker `url`,
  the `devices` allowlist, optional `username`/`password`, `topicPrefix` (default `tuya`),
  `retain`, and `datapointTopics`.
- **Topic layout.** Each allowlisted device publishes:
  - a per-device JSON snapshot to `` `<prefix>/<deviceId>/status` `` containing every
    reported datapoint, and
  - (when `datapointTopics` is on, the default) one bare value per datapoint to
    `` `<prefix>/<deviceId>/<code>` `` — e.g. `tuya/<id>/va_temperature` → `23.5` — so
    single-value consumers can subscribe directly.
- **Automatic value scaling.** Tuya reports decimals as scaled integers; the published
  payload includes both the raw `value` and a `scaled` value derived from each datapoint's
  spec (`scaled = raw / 10^scale`, e.g. `235` → `23.5`), along with the `unit` when known.
- Reuses the existing `mqtt` dependency — no new dependencies added.

## 1.1.0-beta

> ⚠️ **Beta release.** This version adds a large batch of new device types. Support
> is **HAP-only for now** (Matter equivalents will follow). If you hit any problems,
> please [open an issue](https://github.com/talrhv/homebridge-tuya-matter/issues) —
> include the device category code and, if possible, its `status`/`functions` data so
> it can be reproduced.

### Added — New HAP device support

**Sensors**

- **Carbon Monoxide sensor** (`cobj`, `cocgq`) — alarm state + optional CO level.
- **Carbon Dioxide sensor** (`co2bj`, `co2cgq`) — alarm state + optional CO₂ level.
- **Temperature & Humidity sensor** (`wsdcg`) — combined temperature + humidity services.
- **Light sensor** (`ldcg`) — ambient light level (lux).
- **Air Quality sensor** (`pm25`, `pm2.5`, `pm25cgq`, `hjjcy`) — air quality, PM2.5,
  PM10 and VOC, plus optional temperature/humidity.
- **Vibration sensor** (`zd`) — exposed as a motion sensor with automatic reset.
- **Weather station** (`qxj`) — one temperature + humidity service per channel.
- **Water leak detection** added to the existing leak sensor (`sj`).

**Switches & stateless controls**

- **Wireless / battery button** (`wxkg`) — single / double / long-press events.
- **Doorbell** (`wxml`) — press events.
- **Scene switch / panel** (`cjkg`) — momentary scene-trigger buttons.
- **Window opener** (`mc`) — exposed as a Window accessory.

**Climate & appliances**

- **Air Conditioner** (`kt`, `ktkzq`) — heater/cooler with optional dehumidifier and
  fan modes.
- **Sauna** (`qtwk`) — thermostat with main + LED lights.
- **Humidifier** (`jsq`) — with optional integrated light.
- **Dehumidifier** (`cs`) — with fan speed, swing and child lock.
- **Diffuser / aromatherapy** (`xxj`) — purifier with light, spray and sound switches.
- **Range hood** (`yyj`) — purifier with optional light.
- **White-noise / sleep light** (`bzyd`) — light plus a noise/music switch.

**Specialty & security**

- **Security system / alarm panel** (`mal`) — arm / disarm / home + alarm state.
- **Pet feeder** (`cwwsq`) — feed trigger with battery and optional light.
- **Self-cleaning cat toilet** (`msp`) — power, cleaning, deodorization, UV, mood light,
  occupancy and waste-box (filter) status.

### Changed — Test harness

- Rewrote the test suite on Node's built-in test runner (`node:test` + `node:assert`),
  removing the missing `chai` dependency and the CommonJS/ESM mismatch. Integration
  tests now skip automatically until real credentials are set in `test/env.js`.

### Credits

- The new device mappings were inspired by [@0x5e](https://github.com/0x5e)'s fork of
  [homebridge-tuya-platform](https://github.com/0x5e/homebridge-tuya-platform). Thanks! 🙏

## 1.0.6

### Fixed — Motion sensor override timer

- **The motion sensor override timer now works on both HAP and Matter accessories.**
  Previously the configured "time modification" value was not applied reliably, and a
  global entry (one with no specific Device Id) was ignored on the Matter side.
- **Fixed devices going unresponsive after changing the timer.** Changing a motion
  sensor's override timer and restarting Homebridge could leave the Matter accessory
  dead in Apple Home, logging `Accessory <id> not registered or missing endpoint`.
  The plugin no longer tears down a live Matter endpoint when refreshing a cached
  accessory, and the new timer value now takes effect on the **first** restart instead
  of the second.
- **The override no longer ends early.** While the override timer is counting down, a
  "no motion" report from the sensor is ignored until the timer expires, so motion
  stays "detected" for the full configured duration.
- Hardened startup so realtime (MQTT) updates that arrive before a device finishes
  registering can no longer trigger the "missing endpoint" error.

### Changed — Configuration UI

- Motion sensor timer dropdown: renamed the `0` option to **OFF** (the stored value is
  still `0`) and removed the redundant empty/"None" choice, which did the same thing
  as `0`.
