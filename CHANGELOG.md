# Changelog

All notable changes to this project are documented in this file.

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
