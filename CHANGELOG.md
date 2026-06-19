# Changelog

All notable changes to this project are documented in this file.

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
