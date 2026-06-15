# Tuya Device Implementations

Reference document for porting device support to another Tuya smart home integration. Each entry lists the Tuya category codes, the smart home service type it maps to, the DP codes it reads/writes, and any notable implementation details.

---

## Shared Characteristic Helpers

Before implementing individual devices, these reusable helpers are worth extracting:

| Helper | Purpose |
|---|---|
| **Light** | Covers all 6 light types: on/off, brightness-only (C), brightness+color-temp (CW), RGB, RGB+brightness (RGBC), RGB+brightness+color-temp (RGBCW). Handles `work_mode` switching between white/colour modes. |
| **RotationSpeed** | Three variants: integer-based (0–100%), enum-based (speed levels mapped to 0–100%), boolean (on/off only). |
| **AirQuality** | PM2.5, PM10, VOC density with quality bucket mapping. |
| **EnergyUsage** | Custom characteristics for Amperes, Watts, Volts, kWh. Reads `cur_current`, `cur_power`, `cur_voltage`, `add_ele`. |
| **MotionDetected** | Reads either an enum `'pir'` value or a boolean; normalises to motion-detected boolean. |
| **OccupancyDetected** | Reads `presence_state` enum, triggers on `'presence'` value. |
| **SwingMode** | Toggle from `switch_horizontal` or `switch_vertical`. |
| **LockPhysicalControls** | Child lock toggle from `lock` or `child_lock`. |
| **SecuritySystemState** | Maps `master_mode` (arm/disarmed/home) and `sos_state` to ARMED/DISARMED/STAY_ARM/NIGHT_ARM/ALARM_TRIGGERED. |
| **TemperatureDisplayUnits** | Reads `temp_unit_convert` or `c_f`; toggles Celsius/Fahrenheit. |
| **ProgrammableSwitchEvent** | Stateless switch events (single_click / double_click / long_press). |

---

## Lighting

### Light Bulb / Strip / Ceiling Light
**Category codes:** `dj`, `dsd`, `xdd`, `fwd`, `dc`, `dd`, `gyd`, `tyndj`, `sxd`  
**Service:** Lightbulb

| DP Code | Purpose |
|---|---|
| `switch_led` | On/Off |
| `bright_value`, `bright_value_v2` | Brightness |
| `temp_value`, `temp_value_v2` | Color temperature |
| `colour_data`, `colour_data_v2` | HSV color (JSON) |
| `work_mode` | `'white'` vs `'colour'` mode selector |
| `pir_state` | Integrated PIR motion |
| `switch_pir` | Enable/disable PIR |

**Notes:** Auto-detects light type from which DP codes exist on the device. If `bright_value` only → brightness dimmer. If `colour_data` also present → full RGB(CW). Supports adaptive lighting (color-temperature auto-scheduling) when configured.

---

### Dimmer Switch
**Category codes:** `tgq`, `tgkg`  
**Service:** Lightbulb (one service per gang)

| DP Code | Purpose |
|---|---|
| `switch`, `switch_led`, `switch_1`, `switch_led_1` | On/Off (per gang) |
| `bright_value`, `bright_value_1` | Brightness (per gang) |
| `brightness_min_1`, `brightness_max_1` | Brightness range limits (read-only) |

**Notes:** Supports multi-gang by iterating suffixes (`_1`, `_2`, …). Reads brightness min/max from device schema and remaps the 0–100% slider to that hardware range. Also handles `switch_2`/`bright_value_2`, etc.

---

## Electrical / Switches

### Switch
**Category codes:** `dlq`, `kg`, `tdq`, `qjdcz`, `szjqr`  
**Service:** Switch (one per gang)

| DP Code | Purpose |
|---|---|
| `switch`, `switch_1` … `switch_N` | On/Off per gang |
| `cur_current` | Current (A) — custom characteristic |
| `cur_power` | Power (W) — custom characteristic |
| `cur_voltage` | Voltage (V) — custom characteristic |
| `add_ele` | Cumulative energy (kWh) — custom characteristic |
| `va_temperature`, `temp_current` | Optional temperature sensor |
| `va_humidity`, `humidity_value` | Optional humidity sensor |
| `switch_inching` | Inching mode (timed pulse; sent as base64-encoded buffer) |

**Notes:** Detects up to 99 gangs. Energy monitoring and temp/humidity sensor services are added automatically if the relevant DP codes are present.

---

### Outlet / Smart Plug
**Category codes:** `cz`, `pc`, `wkcz`  
**Service:** Outlet (one per socket)

Same DP codes as Switch above. The only difference is the HomeKit service type (Outlet exposes an "in use" characteristic).

---

### Wireless (Battery) Switch / Remote Button
**Category codes:** `wxkg`  
**Service:** StatelessProgrammableSwitch (one per button)

| DP Code | Purpose |
|---|---|
| `switch_mode1` … `switch_modeN` | Button mode selector |
| `switch1_value` … `switchN_value` | Event value (single / double / long press) |

**Notes:** Stateless — no persistent on/off state. Buttons auto-detected by iterating DP code suffixes.

---

### Scene Switch / Panel
**Category codes:** `cjkg`  
**Service:** Switch (one per gang)

| DP Code | Purpose |
|---|---|
| `switch`, `switch_1` … `switch_N` | Gang on/off |
| `mode`, `mode_1` … `mode_N` | Scene trigger (write-only; auto-resets to OFF) |

**Notes:** When activated, sends the mode command then resets itself to OFF after the action completes.

---

### White Noise Light / Sleep Light
**Category codes:** `bzyd`  
**Service:** Lightbulb + Switch (for noise/music)

| DP Code | Purpose |
|---|---|
| `switch_led` | Light on/off |
| `colour_data` | RGB color |
| `switch_music` | White noise / music on/off |

---

## Large Home Appliances

### Air Conditioner
**Category codes:** `kt`, `ktkzq`  
**Service:** HeaterCooler (primary) + HumidifierDehumidifier (if `'wet'` mode exists) + Fanv2 (if `'wind'` mode exists)

| DP Code | Purpose |
|---|---|
| `switch` | Main power |
| `mode` | Mode: `cool`/`heat`/`auto`/`wind`/`wet` |
| `temp_current` | Current temperature |
| `temp_set` | Target temperature |
| `fan_speed_enum`, `windspeed` | Fan speed level |
| `lock`, `child_lock` | Child lock |
| `temp_unit_convert`, `c_f` | °C/°F toggle |
| `humidity_current`, `humidity_set` | Humidity (dehumidifier mode) |

**Notes:** Services are conditional — only created if the mode schema's `range` includes `'wet'` or `'wind'`. The active service changes dynamically as the mode DP changes.

---

### Sauna
**Category codes:** `qtwk`  
**Service:** Thermostat + Lightbulb (main light) + Lightbulb (LED accent)

| DP Code | Purpose |
|---|---|
| `powerswitch` | On/Off |
| `currtemp` | Current temperature |
| `settemp` | Target temperature (30–90 °C) |
| `temp_unit_convert`, `c_f` | °C/°F |
| `lightswitch` | Main light on/off |
| `ledswitch` | LED accent light on/off |

---

## Small Home Appliances

### Heater
**Category codes:** `qn`  
**Service:** HeaterCooler

| DP Code | Purpose |
|---|---|
| `switch` | Active |
| `work_state` | Current state (`'heating'`/`'warming'`) |
| `temp_current` | Current temperature |
| `temp_set` | Target temperature |
| `lock` | Child lock |
| `shake` | Swing / oscillation |
| `temp_unit_convert`, `c_f` | °C/°F |

---

### Fan
**Category codes:** `fs`, `fsd`, `fskg`  
**Service:** Fan or Fanv2 (selected based on schema) + optional Lightbulb

| DP Code | Purpose |
|---|---|
| `switch_fan`, `fan_switch`, `switch` | Fan on/off |
| `fan_speed`, `fan_speed_percent` | Speed (integer 0–100%) |
| `fan_speed_enum` | Speed level (enum) |
| `fan_direction` | Rotation direction (`forward`/`reverse`) |
| `child_lock` | Child lock |
| `switch_horizontal`, `switch_vertical` | Swing |
| `light`, `switch_led` | Integrated light on/off |
| `bright_value`, `bright_value_v2` | Light brightness |
| `colour_data`, `work_mode` | Light color / mode |

**Notes:** Uses Fanv2 service if child lock or swing DPs are present (required for those characteristics). Optionally supports dual light types (warm + white).

---

### Humidifier
**Category codes:** `jsq`  
**Service:** HumidifierDehumidifier

| DP Code | Purpose |
|---|---|
| `switch` | Active |
| `humidity_current` | Current humidity |
| `humidity_set` | Target humidity |
| `temp_current` | Current temperature (optional) |
| `mode` | Spray mode (set to `'humidity'` when adjusting target) |
| `switch_led`, `bright_value` | Integrated light |
| `colour_data`, `colour_data_hsv` | Light color |

---

### Dehumidifier
**Category codes:** `cs`  
**Service:** HumidifierDehumidifier

| DP Code | Purpose |
|---|---|
| `switch` | Active |
| `humidity_indoor` | Current humidity |
| `dehumidify_set_value` | Target humidity |
| `temp_indoor` | Current temperature (optional) |
| `fan_speed_enum` | Fan speed level |
| `swing` | Swing |
| `child_lock` | Child lock |

---

### Diffuser / Aromatherapy
**Category codes:** `xxj`  
**Service:** AirPurifier + Lightbulb + Switch (spray) + Switch (sound)

| DP Code | Purpose |
|---|---|
| `switch` | Main power |
| `switch_spray` | Spray on/off |
| `mode` | Spray mode |
| `level` | Spray level |
| `switch_led` | Light on/off |
| `bright_value`, `bright_value_v2` | Light brightness |
| `colour_data`, `colour_data_hsv` | Light color |
| `work_mode` | Light mode |
| `switch_sound` | Sound on/off |

---

### Air Purifier
**Category codes:** `kj`  
**Service:** AirPurifier

| DP Code | Purpose |
|---|---|
| `switch` | Active |
| `mode` | Mode (`auto`/`manual`) |
| `lock` | Child lock |
| `speed` | Fan speed (integer) |
| `fan_speed_enum` | Fan speed (enum) |
| `air_quality`, `pm25` | Air quality |
| `tvoc` | VOC level |

---

### Extraction / Range Hood
**Category codes:** `yyj`  
**Service:** AirPurifier + optional Lightbulb

| DP Code | Purpose |
|---|---|
| `switch` | Active |
| `mode` | Mode |
| `lock` | Child lock |
| `speed` | Fan speed (integer) |
| `fan_speed_enum` | Fan speed (enum) |
| `air_quality`, `pm25` | Air quality |
| `tvoc` | VOC |
| `light`, `switch_led` | Light on/off |
| `bright_value`, `bright_value_v2` | Light brightness |
| `temp_value`, `temp_value_v2` | Light color temperature |
| `colour_data` | Light color |
| `work_mode` | Light mode |

---

### Valve / Irrigation Controller
**Category codes:** `ggq`, `sfkzq`  
**Service:** Valve (one per zone, irrigation type)

| DP Code | Purpose |
|---|---|
| `switch`, `switch_1` … `switch_N` | Zone on/off (boolean only) |

**Notes:** Only boolean DP codes are used; integer/enum codes ignored. Multi-zone detected by iterating `switch_*` suffixes.

---

## Window / Door

### Window Covering / Curtain Motor
**Category codes:** `cl`, `clkg`  
**Service:** WindowCovering (up to 2 independent curtains)

| DP Code | Purpose |
|---|---|
| `percent_state` | Current position (0–100%) |
| `control`, `mach_operate` | Open/close/stop command (enum) |
| `percent_control`, `position` | Target position (0–100%) |
| `control_2`, `percent_control_2` | Second curtain (same pattern) |

**Notes:** Handles both old (`'ZZ'`/`'FZ'`/`'STOP'`) and new (`'open'`/`'close'`/`'stop'`) command formats. Second curtain service is added when `control_2` or `percent_control_2` DPs exist.

---

### Window Opener
**Category codes:** `mc`  
Same implementation as Window Covering but uses the **Window** HomeKit service.

---

### Garage Door
**Category codes:** `ckmkzq`  
**Service:** GarageDoorOpener

| DP Code | Purpose |
|---|---|
| `doorcontact_state` | Current door state (boolean) |
| `switch_1` | Open/close command |

---

## Access Control

### Smart Lock
**Category codes:** `ms`, `jtmspro`  
**Service:** LockMechanism

| DP Code | Purpose |
|---|---|
| `open_close`, `closed_opened`, `lock_motor_state` | Current lock state |
| `lock_motor_state` | Target lock state |

**Notes:** Unlock flow requires two API calls: first acquire a temporary password ticket, then send the actual unlock command. This is a security requirement of Tuya's Smart Lock API.

---

## Sensors

### Contact Sensor
**Category codes:** `mcs`  
**Service:** ContactSensor  
**DPs:** `doorcontact_state`, `switch`

---

### Motion Sensor (PIR)
**Category codes:** `pir`  
**Service:** MotionSensor  
**DPs:** `pir` (triggers on enum value `'pir'`)

---

### Leak Sensor (Water / Gas / CH4)
**Category codes:** `rqbj`, `jwbj`, `sj`  
**Service:** LeakSensor  
**DPs:** `gas_sensor_status`, `gas_sensor_state`, `ch4_sensor_state`, `watersensor_state`  
**Notes:** Triggers on value `'alarm'` or `1`.

---

### Smoke Sensor
**Category codes:** `ywbj`  
**Service:** SmokeSensor  
**DPs:** `smoke_sensor_status`, `smoke_sensor_state`  
**Notes:** Triggers on `'alarm'` or `1`.

---

### CO Sensor
**Category codes:** `cobj`, `cocgq`  
**Service:** CarbonMonoxideSensor  
**DPs:** `co_status`, `co_state` (alarm), `co_value` (PPM, optional)

---

### CO₂ Sensor
**Category codes:** `co2bj`, `co2cgq`  
**Service:** CarbonDioxideSensor  
**DPs:** `co2_state` (alarm), `co2_value` (PPM 0–100 000, optional)

---

### Temperature & Humidity Sensor
**Category codes:** `wsdcg`  
**Services:** TemperatureSensor + HumiditySensor  
**DPs:** `va_temperature`, `va_humidity`, `humidity_value`

---

### Weather Station (Multi-Channel Temp/Humidity)
**Category codes:** `qxj`  
**Services:** One TemperatureSensor + HumiditySensor per channel  
**DPs:** `ToutCh1`…`ToutChN` (temperature), `HoutCh1`…`HoutChN` (humidity)  
**Notes:** Dynamically discovers the number of channels by scanning schema for matching DP code patterns.

---

### Light Sensor
**Category codes:** `ldcg`  
**Service:** LightSensor  
**DPs:** `bright_value` (reported as lux, range 0.0001–100 000)

---

### Air Quality Sensor
**Category codes:** `pm25`, `pm2.5`, `pm25cgq`, `hjjcy`  
**Service:** AirQualitySensor + optional TemperatureSensor + HumiditySensor

| DP Code | Purpose |
|---|---|
| `pm25_value` | PM2.5 + overall air quality |
| `pm10_value`, `pm10` | PM10 |
| `voc_value` | VOC |
| `va_temperature`, `temp_indoor`, `temp_current` | Temperature (optional) |
| `va_humidity`, `humidity_value` | Humidity (optional) |

---

### Human Presence Sensor
**Category codes:** `hps`  
**Service:** OccupancySensor  
**DPs:** `presence_state` (triggers on `'presence'` enum value)

---

### Vibration Sensor
**Category codes:** `zd`  
**Service:** MotionSensor  
**DPs:** `shock_state` (triggers on `'vibration'` or `'drop'`)  
**Notes:** Auto-resets MotionDetected to false after 3 seconds (event-style behaviour).

---

## Security & Cameras

### IP Camera
**Category codes:** `sp`  
**Services:** CameraRTPStreamManagement + MotionSensor + optional Doorbell + optional Lightbulb

| DP Code | Purpose |
|---|---|
| `motion_switch` | Enable motion detection |
| `movement_detect_pic` | Motion event (base64 image) |
| `doorbell_pic` | Doorbell ring event (base64 image) |
| `alarm_message` | Alarm event |
| `floodlight_switch` | Floodlight on/off |
| `floodlight_lightness` | Floodlight brightness |

**Notes:** Uses RTSP via `TuyaStreamDelegate`. Motion-detected flag auto-resets after 30 seconds. Doorbell ring auto-resets after a short delay. Floodlight service only added if `floodlight_switch` DP is present.

---

### Doorbell
**Category codes:** `wxml`  
**Service:** StatelessProgrammableSwitch  
**DPs:** `doorbell_call`  
**Notes:** Standalone doorbell (not integrated in a camera). Fires single/double/long-press events.

---

### Security System / Alarm Panel
**Category codes:** `mal`  
**Service:** SecuritySystem

| DP Code | Purpose |
|---|---|
| `master_mode` | `'arm'` / `'disarmed'` / `'home'` |
| `sos_state` | SOS / alarm triggered |

**Notes:** `'arm'` maps to AWAY_ARM. `'home'` maps to STAY_ARM or NIGHT_ARM (persisted per-instance; defaults to STAY_ARM). SOS clears when disarmed.

---

## Specialty Devices

### Pet Feeder
**Category codes:** `cwwsq`  
**Service:** Switch + Battery

| DP Code | Purpose |
|---|---|
| `quick_feed`, `slow_feed`, `manual_feed` | Trigger feeding (write `true`) |
| `light` | Feeder light |
| `meal_plan` | Meal plan configuration |
| `battery_percentage` | Battery level |
| `feed_report` | Last feed report |
| `feed_state` | Feeding status (active when `'feeding'`) |

---

### Self-Cleaning Cat Toilet
**Category codes:** `msp`  
**Services:** Switch (power) + Switch (auto clean) + Switch (manual clean) + Switch (deodorization) + Switch (UV) + Lightbulb (mood light) + OccupancySensor + FilterMaintenance (waste box)

| DP Code | Purpose |
|---|---|
| `switch` | Main power |
| `auto_clean` | Auto clean cycle |
| `manual_clean` | Manual clean |
| `deodorization` | Deodorization |
| `uv` | UV sterilization |
| `light` | Mood light |
| `status` | Occupancy (`'cleaning'`/`'uv'`/`'deodorization'` = occupied) |
| `notification` | Bitfield — bit 0 = waste box full (FilterMaintenance) |
| `fault` | Fault state |

---

## Scenes & IR Remotes

### Tuya Scene (Tap-to-Run)
**Category code:** `scene` (virtual, populated by Smart Home project)  
**Service:** Switch  
**Notes:** Executes the scene via API; auto-resets to OFF after 150 ms. Only available in Smart Home project type.

---

### IR Control Hub
**Detection:** `device.category` is `wnykq`, `hwktwkq`, or `wsdykq`  
**Service:** TemperatureSensor + HumiditySensor (if hub has those DPs)  
**DPs:** `va_temperature`, `va_humidity`, `humidity_value`  
**Notes:** Parent device for IR remotes. When it receives a status update it propagates to sub-devices.

---

### IR Generic Remote
**Detection:** `device.remote_keys` is set and `category_id ≠ 5`  
**Service:** Switch (one per button key, up to 99)  
**Notes:** Buttons auto-reset to OFF after 150 ms. Supports learned IR codes stored on the device.

---

### IR Air Conditioner Remote
**Detection:** `device.remote_keys` is set and `category_id = 5`  
**Services:** HeaterCooler + optional HumidifierDehumidifier + optional Fanv2

| Virtual DP | Values | Purpose |
|---|---|---|
| `power` | 0 / 1 | Off / On |
| `mode` | 0 = cool / 1 = heat / 2 = auto / 3 = fan / 4 = dehumid | Mode |
| `temp` | (from key_range per mode) | Target temperature |
| `wind` | 0 = auto / 1 = low / 2 = med / 3 = high | Fan speed |

**Notes:** No real DP codes — all state is synthesised from the IR key database. Commands are debounced (100 ms) before sending. Dehumidifier and fan services are only created if those modes exist in `key_range`. Humidity is pulled from the parent IR hub device.

---

## Implementation Pattern

When adding a new device type to another project, follow this pattern:

1. **Identify category code(s)** from the device list JSON (`TuyaDeviceList.*.json`) or Tuya documentation.
2. **Inspect `schema` and `status`** in the device JSON to confirm which DPs are actually present — many are optional.
3. **Map each DP code to the closest service characteristic.** Use `getSchema(...alternativeCodes)` to support multiple naming variants in priority order.
4. **Check `mode`/`type` on each schema:** `rw` = read + write, `ro` = read only, `wo` = write only. Only add `onGet` handlers for `rw`/`ro`; only add `onSet` for `rw`/`wo`.
5. **Debounce related writes** (e.g., send brightness + color together rather than as two separate commands) to avoid flickering.
6. **Auto-reset stateless events** (scenes, IR buttons, doorbells) to OFF/false after a short delay (100–150 ms).
7. **Gate optional services** — only add a service (e.g., LightSensor, HumiditySensor) when the corresponding schema code exists on the device.
