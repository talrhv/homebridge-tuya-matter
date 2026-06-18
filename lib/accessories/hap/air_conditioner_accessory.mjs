"use strict";

import BaseAccessory from "./base_accessory.mjs";

const AC_MODES = ["auto", "cold", "cool", "hot", "heat"];
const DEHUMIDIFIER_MODE = "wet";
const FAN_MODE = "wind";

class AirConditionerAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.AIR_CONDITIONER,
      Service.HeaterCooler,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.modeRange = this._getEnumRange("mode");
    this.tempSetRange = this._getRange("temp_set") || { min: 16, max: 30, scale: 0 };
    this.speedCode = ["fan_speed_enum", "windspeed"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    this.speedRange = this.speedCode ? this._getEnumRange(this.speedCode) : [];
    this.lockCode = ["lock", "child_lock"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    this.unitCode = ["temp_unit_convert", "c_f"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );

    // DP state
    this.switchMap = null;
    this.modeMap = null;
    this.tempCurrentMap = null;
    this.tempSetMap = null;
    this.speedMap = null;
    this.lockMap = null;
    this.unitMap = null;
    this.humidityCurrentMap = null;
    this.humiditySetMap = null;

    // שירותים משניים נוצרים רק אם המצב נתמך.
    this.dehumidifierService = this.modeRange.includes(DEHUMIDIFIER_MODE)
      ? this.homebridgeAccessory.getService(Service.HumidifierDehumidifier) ||
        this.homebridgeAccessory.addService(
          Service.HumidifierDehumidifier,
          `${this._sanitizeName(deviceConfig.name)} Dehumidifier`,
          "ac_dehumidifier",
        )
      : null;
    this.fanService = this.modeRange.includes(FAN_MODE)
      ? this.homebridgeAccessory.getService(Service.Fanv2) ||
        this.homebridgeAccessory.addService(
          Service.Fanv2,
          `${this._sanitizeName(deviceConfig.name)} Fan`,
          "ac_fan",
        )
      : null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- Active ---
    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this._isAcActive())
      .onSet(async (value) => {
        const commands = [{ code: "switch", value: value ? true : false }];
        if (value && this.modeMap && !AC_MODES.includes(this.modeMap.value)) {
          const fallback = AC_MODES.find((m) => this.modeRange.includes(m));
          if (fallback) commands.push({ code: this.modeMap.code, value: fallback });
        }
        await this._send(commands);
      });

    // --- Current State ---
    service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this._currentState());

    // --- Target State ---
    const validValues = this._targetValidValues();
    if (validValues.length) {
      service
        .getCharacteristic(Characteristic.TargetHeaterCoolerState)
        .setProps({ validValues })
        .onGet(() => this._targetState())
        .onSet(async (value) => {
          const { AUTO, HEAT, COOL } = Characteristic.TargetHeaterCoolerState;
          let mode = "auto";
          if (value === HEAT) mode = this.modeRange.includes("hot") ? "hot" : "heat";
          else if (value === COOL)
            mode = this.modeRange.includes("cold") ? "cold" : "cool";
          await this._send([{ code: "mode", value: mode }]);
        });
    }

    // --- Current Temperature ---
    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -20, maxValue: 100, minStep: 0.1 })
      .onGet(() => this._scaled(this.tempCurrentMap, "temp_current"));

    // --- Threshold temperatures ---
    if (this.statusArr.some((s) => s.code === "temp_set")) {
      const props = {
        minValue: this.tempSetRange.min,
        maxValue: this.tempSetRange.max,
        minStep: 1,
      };
      service
        .getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps(props)
        .onGet(() => this._scaled(this.tempSetMap, "temp_set"))
        .onSet(async (value) => this._sendTempSet(value));
      service
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps(props)
        .onGet(() => this._scaled(this.tempSetMap, "temp_set"))
        .onSet(async (value) => this._sendTempSet(value));
    }

    // --- Display units ---
    if (this.unitCode) {
      service
        .getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .onGet(() => this._displayUnit())
        .onSet(async (value) => {
          await this._send([
            { code: this.unitCode, value: this._unitToTuya(value) },
          ]);
        });
    }

    // --- Lock ---
    if (this.lockCode) {
      service
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .onGet(() => (this.lockMap?.value ? 1 : 0))
        .onSet(async (value) => {
          await this._send([{ code: this.lockCode, value: Boolean(value) }]);
        });
    }

    // --- Rotation speed (enum levels) ---
    if (this.speedCode && this.speedRange.length) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: this.speedRange.length, minStep: 1 })
        .onGet(() => this._speedToHb())
        .onSet(async (value) => this._sendSpeed(value));
    }

    this._initDehumidifier();
    this._initFan();
  }

  _initDehumidifier() {
    if (!this.dehumidifierService) return;
    const { Characteristic } = this.platform.api.hap;
    const service = this.dehumidifierService;

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.switchMap?.value && this.modeMap?.value === DEHUMIDIFIER_MODE
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE,
      )
      .onSet(async (value) => {
        await this._send([
          { code: "switch", value: value ? true : false },
          { code: "mode", value: DEHUMIDIFIER_MODE },
        ]);
      });

    service.setCharacteristic(
      Characteristic.CurrentHumidifierDehumidifierState,
      Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
    );
    service
      .getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
      .setProps({
        validValues: [
          Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
        ],
      })
      .updateValue(
        Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
      );

    service
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this._scaled(this.humidityCurrentMap, "humidity_current"));

    if (this.statusArr.some((s) => s.code === "humidity_set")) {
      service
        .getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold)
        .onGet(() => this._scaled(this.humiditySetMap, "humidity_set"))
        .onSet(async (value) => {
          await this._send([{ code: "humidity_set", value }]);
        });
    }
  }

  _initFan() {
    if (!this.fanService) return;
    const { Characteristic } = this.platform.api.hap;
    this.fanService
      .getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.switchMap?.value && this.modeMap?.value === FAN_MODE
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE,
      )
      .onSet(async (value) => {
        await this._send([
          { code: "switch", value: value ? true : false },
          { code: "mode", value: FAN_MODE },
        ]);
      });
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "switch":
          this.switchMap = statusMap;
          break;
        case "mode":
          this.modeMap = statusMap;
          break;
        case "temp_current":
          this.tempCurrentMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.CurrentTemperature)
            .updateValue(this._scaled(statusMap, "temp_current"));
          break;
        case "temp_set":
          this.tempSetMap = statusMap;
          break;
        case "lock":
        case "child_lock":
          this.lockMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.LockPhysicalControls)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "temp_unit_convert":
        case "c_f":
          this.unitMap = statusMap;
          break;
        case "fan_speed_enum":
        case "windspeed":
          this.speedMap = statusMap;
          break;
        case "humidity_current":
          this.humidityCurrentMap = statusMap;
          break;
        case "humidity_set":
          this.humiditySetMap = statusMap;
          break;
      }
    }

    // עדכון מצב פעיל/כיבוי תלוי במספר DPs, לכן מרעננים אחרי הלולאה.
    this.service
      .getCharacteristic(Characteristic.Active)
      .updateValue(this._isAcActive());
    this.service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .updateValue(this._currentState());

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  // --- helpers ---

  _isAcActive() {
    const { Characteristic } = this.platform.api.hap;
    return this.switchMap?.value &&
      (!this.modeMap || AC_MODES.includes(this.modeMap.value))
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  }

  _currentState() {
    const { INACTIVE, HEATING, COOLING, IDLE } =
      this.platform.api.hap.Characteristic.CurrentHeaterCoolerState;
    if (!this.switchMap?.value) return INACTIVE;
    const v = this.modeMap?.value;
    if (v === "hot" || v === "heat" || v === "heating") return HEATING;
    if (v === "cold" || v === "cool" || v === "cooling") return COOLING;
    return IDLE;
  }

  _targetValidValues() {
    const { AUTO, HEAT, COOL } =
      this.platform.api.hap.Characteristic.TargetHeaterCoolerState;
    const valid = [];
    if (this.modeRange.includes("auto")) valid.push(AUTO);
    if (this.modeRange.includes("hot") || this.modeRange.includes("heat"))
      valid.push(HEAT);
    if (this.modeRange.includes("cold") || this.modeRange.includes("cool"))
      valid.push(COOL);
    return valid;
  }

  _targetState() {
    const { AUTO, HEAT, COOL } =
      this.platform.api.hap.Characteristic.TargetHeaterCoolerState;
    const v = this.modeMap?.value;
    if (v === "hot" || v === "heat") return HEAT;
    if (v === "cold" || v === "cool") return COOL;
    return AUTO;
  }

  _displayUnit() {
    const { CELSIUS, FAHRENHEIT } =
      this.platform.api.hap.Characteristic.TemperatureDisplayUnits;
    const v = this.unitMap?.value;
    return v === "f" || v === "F" || v === true ? FAHRENHEIT : CELSIUS;
  }

  _unitToTuya(value) {
    const { FAHRENHEIT } =
      this.platform.api.hap.Characteristic.TemperatureDisplayUnits;
    return value === FAHRENHEIT ? "f" : "c";
  }

  async _sendTempSet(value) {
    const scale = Math.pow(10, this.tempSetRange.scale || 0);
    await this._send([{ code: "temp_set", value: Math.round(value * scale) }]);
  }

  _speedToHb() {
    if (!this.speedMap) return 0;
    const index = this.speedRange.indexOf(this.speedMap.value);
    return index >= 0 ? index + 1 : 0;
  }

  async _sendSpeed(value) {
    const index = Math.round(value) - 1;
    if (index < 0 || index >= this.speedRange.length) return;
    await this._send([{ code: this.speedCode, value: this.speedRange[index] }]);
  }

  _scaled(statusMap, code) {
    if (!statusMap) return 0;
    const scale = this._getScale(code);
    return statusMap.value / scale;
  }

  async _send(commands) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, { commands });
    } catch (error) {
      this.log.error(`[SET] Failed to send AC command:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  _getScale(code) {
    const range = this._getRange(code);
    return range ? Math.pow(10, range.scale || 0) : 1;
  }

  _getRange(code) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func) {
      try {
        const values = JSON.parse(func.values);
        return {
          min: parseInt(values.min),
          max: parseInt(values.max),
          scale: values.scale || 0,
        };
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  _getEnumRange(code) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func) {
      try {
        const values = JSON.parse(func.values);
        if (Array.isArray(values.range)) return values.range;
      } catch (e) {
        /* ignore */
      }
    }
    return [];
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default AirConditionerAccessory;
