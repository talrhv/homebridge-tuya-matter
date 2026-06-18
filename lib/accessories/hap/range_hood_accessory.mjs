"use strict";

import BaseAccessory from "./base_accessory.mjs";

const DEFAULT_SPEED_COUNT = 3;

class RangeHoodAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.AIR_PURIFIER,
      Service.AirPurifier,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.speedCode = ["speed", "fan_speed_enum"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    this.speed_count = this._getSpeedCount(this.speedCode);
    this.speed_coefficient = 100 / this.speed_count;
    this.brightRange = this._getRange("bright_value") || { min: 10, max: 1000, scale: 0 };

    this.switchMap = null;
    this.modeMap = null;
    this.lockMap = null;
    this.speedMap = null;
    this.lightOn = false;
    this.brightMap = null;

    this.lightCode = ["light", "switch_led"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    this.lightService = this.lightCode
      ? this.homebridgeAccessory.getService(Service.Lightbulb) ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          `${this._sanitizeName(deviceConfig.name)} Light`,
          "hood_light",
        )
      : null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.switchMap?.value
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE,
      )
      .onSet(async (value) => {
        await this._send([{ code: "switch", value: value ? true : false }]);
      });

    service
      .getCharacteristic(Characteristic.CurrentAirPurifierState)
      .onGet(() =>
        this.switchMap?.value
          ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
          : Characteristic.CurrentAirPurifierState.INACTIVE,
      );

    if (this.statusArr.some((s) => s.code === "mode")) {
      service
        .getCharacteristic(Characteristic.TargetAirPurifierState)
        .onGet(() =>
          this.modeMap?.value === "auto"
            ? Characteristic.TargetAirPurifierState.AUTO
            : Characteristic.TargetAirPurifierState.MANUAL,
        )
        .onSet(async (value) => {
          await this._send([
            {
              code: "mode",
              value:
                value === Characteristic.TargetAirPurifierState.AUTO
                  ? "auto"
                  : "manual",
            },
          ]);
        });
    }

    if (this.statusArr.some((s) => s.code === "lock")) {
      service
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .onGet(() => (this.lockMap?.value ? 1 : 0))
        .onSet(async (value) => {
          await this._send([{ code: "lock", value: Boolean(value) }]);
        });
    }

    if (this.speedCode) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .onGet(() => this._speedToHb(this.speedMap?.value))
        .onSet(async (value) => this._sendSpeed(value));
    }

    if (this.lightService) {
      this.lightService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.lightOn)
        .onSet(async (value) => {
          await this._send([{ code: this.lightCode, value: Boolean(value) }]);
        });
      if (this.statusArr.some((s) => s.code === "bright_value")) {
        this.lightService
          .getCharacteristic(Characteristic.Brightness)
          .onGet(() =>
            this._scaleTuyaToHb(this.brightMap?.value || 0, this.brightRange),
          )
          .onSet(async (value) => {
            await this._send([
              {
                code: "bright_value",
                value: this._scaleHbToTuya(value, this.brightRange),
              },
            ]);
          });
      }
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "switch":
          this.switchMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.Active)
            .updateValue(statusMap.value ? 1 : 0);
          this.service
            .getCharacteristic(Characteristic.CurrentAirPurifierState)
            .updateValue(statusMap.value ? 2 : 0);
          break;
        case "mode":
          this.modeMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.TargetAirPurifierState)
            .updateValue(statusMap.value === "auto" ? 1 : 0);
          break;
        case "lock":
          this.lockMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.LockPhysicalControls)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "speed":
        case "fan_speed_enum":
          this.speedMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.RotationSpeed)
            .updateValue(this._speedToHb(statusMap.value));
          break;
        case "light":
        case "switch_led":
          this.lightOn = Boolean(statusMap.value);
          this.lightService
            ?.getCharacteristic(Characteristic.On)
            .updateValue(this.lightOn);
          break;
        case "bright_value":
          this.brightMap = statusMap;
          this.lightService
            ?.getCharacteristic(Characteristic.Brightness)
            .updateValue(this._scaleTuyaToHb(statusMap.value, this.brightRange));
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _speedToHb(value) {
    if (value == null) return 0;
    if (this.speedCode === "fan_speed_enum") {
      const map = { low: 1, mid: 2, high: 3 };
      return Math.floor((map[value] || 1) * this.speed_coefficient);
    }
    return Math.floor((parseInt(value) || 1) * this.speed_coefficient);
  }

  async _sendSpeed(hbValue) {
    let level = Math.floor(hbValue / this.speed_coefficient) || 1;
    level = Math.min(level, this.speed_count);
    let value;
    if (this.speedCode === "fan_speed_enum") {
      value = ["low", "mid", "high"][level - 1] || "low";
    } else {
      value = String(level);
    }
    await this._send([{ code: this.speedCode, value }]);
  }

  _scaleTuyaToHb(value, range) {
    return Math.floor(((value - range.min) * 100) / (range.max - range.min));
  }

  _scaleHbToTuya(value, range) {
    return Math.floor(((range.max - range.min) * value) / 100 + range.min);
  }

  async _send(commands) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, { commands });
    } catch (error) {
      this.log.error(`[SET] Failed to send range hood command:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  _getSpeedCount(code) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func) {
      try {
        const values = JSON.parse(func.values);
        if (Array.isArray(values.range)) return values.range.length;
        if (values.max != null)
          return parseInt(values.max) - parseInt(values.min || 0) || DEFAULT_SPEED_COUNT;
      } catch (e) {
        return DEFAULT_SPEED_COUNT;
      }
    }
    return DEFAULT_SPEED_COUNT;
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

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default RangeHoodAccessory;
