"use strict";

import BaseAccessory from "./base_accessory.mjs";

class DehumidifierAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.AIR_DEHUMIDIFIER,
      Service.HumidifierDehumidifier,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.targetCode = "dehumidify_set_value";
    this.targetRange = this._getRange(this.targetCode) || { min: 0, max: 100, scale: 0 };
    this.speedRange = this._getEnumRange("fan_speed_enum");

    this.switchMap = null;
    this.currentHumidityMap = null;
    this.targetHumidityMap = null;
    this.speedMap = null;
    this.swingMap = null;
    this.lockMap = null;

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
      .getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(() =>
        this.switchMap?.value
          ? Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING
          : Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
      );

    service
      .getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
      .setProps({
        validValues: [
          Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
        ],
      })
      .onGet(
        () => Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
      );

    service
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this._scaled(this.currentHumidityMap, "humidity_indoor"));

    if (this.statusArr.some((s) => s.code === this.targetCode)) {
      service
        .getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold)
        .onGet(() => this._scaled(this.targetHumidityMap, this.targetCode))
        .onSet(async (value) => {
          const scale = Math.pow(10, this.targetRange.scale || 0);
          await this._send([
            { code: this.targetCode, value: Math.round(value * scale) },
          ]);
        });
    }

    if (this.statusArr.some((s) => s.code === "child_lock")) {
      service
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .onGet(() => (this.lockMap?.value ? 1 : 0))
        .onSet(async (value) => {
          await this._send([{ code: "child_lock", value: Boolean(value) }]);
        });
    }

    if (this.statusArr.some((s) => s.code === "swing")) {
      service
        .getCharacteristic(Characteristic.SwingMode)
        .onGet(() => (this.swingMap?.value ? 1 : 0))
        .onSet(async (value) => {
          await this._send([{ code: "swing", value: Boolean(value) }]);
        });
    }

    if (this.speedRange.length) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: this.speedRange.length, minStep: 1 })
        .onGet(() => {
          if (!this.speedMap) return 0;
          const i = this.speedRange.indexOf(this.speedMap.value);
          return i >= 0 ? i + 1 : 0;
        })
        .onSet(async (value) => {
          const i = Math.round(value) - 1;
          if (i < 0 || i >= this.speedRange.length) return;
          await this._send([
            { code: "fan_speed_enum", value: this.speedRange[i] },
          ]);
        });
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
            .getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState)
            .updateValue(statusMap.value ? 3 : 0);
          break;
        case "humidity_indoor":
          this.currentHumidityMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .updateValue(this._scaled(statusMap, "humidity_indoor"));
          break;
        case "dehumidify_set_value":
          this.targetHumidityMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold)
            .updateValue(this._scaled(statusMap, this.targetCode));
          break;
        case "child_lock":
          this.lockMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.LockPhysicalControls)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "swing":
          this.swingMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.SwingMode)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "fan_speed_enum":
          this.speedMap = statusMap;
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _scaled(statusMap, code) {
    if (!statusMap) return 0;
    return Math.min(100, Math.max(0, statusMap.value / this._getScale(code)));
  }

  async _send(commands) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, { commands });
    } catch (error) {
      this.log.error(`[SET] Failed to send dehumidifier command:`, error);
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

export default DehumidifierAccessory;
