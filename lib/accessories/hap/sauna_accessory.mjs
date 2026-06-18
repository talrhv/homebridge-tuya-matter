"use strict";

import BaseAccessory from "./base_accessory.mjs";

class SaunaAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.THERMOSTAT,
      Service.Thermostat,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.tempSetRange = this._getRange("settemp") || { min: 30, max: 90, scale: 0 };
    this.unitCode = ["temp_unit_convert", "c_f"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );

    this.powerMap = null;
    this.currTempMap = null;
    this.setTempMap = null;
    this.unitMap = null;
    this.lightMap = null;
    this.ledMap = null;

    this.mainLightService = this.statusArr.some((s) => s.code === "lightswitch")
      ? this.homebridgeAccessory.getServiceById(Service.Lightbulb, "sauna_light") ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          `${this._sanitizeName(deviceConfig.name)} Light`,
          "sauna_light",
        )
      : null;
    this.ledService = this.statusArr.some((s) => s.code === "ledswitch")
      ? this.homebridgeAccessory.getServiceById(Service.Lightbulb, "sauna_led") ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          `${this._sanitizeName(deviceConfig.name)} LED`,
          "sauna_led",
        )
      : null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.CurrentHeatingCoolingState.OFF,
          Characteristic.CurrentHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() =>
        this.powerMap?.value
          ? Characteristic.CurrentHeatingCoolingState.HEAT
          : Characteristic.CurrentHeatingCoolingState.OFF,
      );

    service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() =>
        this.powerMap?.value
          ? Characteristic.TargetHeatingCoolingState.HEAT
          : Characteristic.TargetHeatingCoolingState.OFF,
      )
      .onSet(async (value) => {
        const on = value === Characteristic.TargetHeatingCoolingState.HEAT;
        await this._send([{ code: "powerswitch", value: on }]);
      });

    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 120, minStep: 0.1 })
      .onGet(() => this._scaled(this.currTempMap, "currtemp"));

    service
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.tempSetRange.min,
        maxValue: this.tempSetRange.max,
        minStep: 1,
      })
      .onGet(() => this._scaled(this.setTempMap, "settemp"))
      .onSet(async (value) => {
        const scale = Math.pow(10, this.tempSetRange.scale || 0);
        await this._send([{ code: "settemp", value: Math.round(value * scale) }]);
      });

    service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => this._displayUnit())
      .onSet(async (value) => {
        if (!this.unitCode) return;
        await this._send([
          { code: this.unitCode, value: this._unitToTuya(value) },
        ]);
      });

    if (this.mainLightService) {
      this.mainLightService
        .getCharacteristic(Characteristic.On)
        .onGet(() => Boolean(this.lightMap?.value))
        .onSet(async (value) => {
          await this._send([{ code: "lightswitch", value: Boolean(value) }]);
        });
    }
    if (this.ledService) {
      this.ledService
        .getCharacteristic(Characteristic.On)
        .onGet(() => Boolean(this.ledMap?.value))
        .onSet(async (value) => {
          await this._send([{ code: "ledswitch", value: Boolean(value) }]);
        });
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "powerswitch":
          this.powerMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .updateValue(statusMap.value ? 1 : 0);
          this.service
            .getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .updateValue(statusMap.value ? 1 : 0);
          break;
        case "currtemp":
          this.currTempMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.CurrentTemperature)
            .updateValue(this._scaled(statusMap, "currtemp"));
          break;
        case "settemp":
          this.setTempMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.TargetTemperature)
            .updateValue(this._scaled(statusMap, "settemp"));
          break;
        case "temp_unit_convert":
        case "c_f":
          this.unitMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .updateValue(this._displayUnit());
          break;
        case "lightswitch":
          this.lightMap = statusMap;
          this.mainLightService
            ?.getCharacteristic(Characteristic.On)
            .updateValue(Boolean(statusMap.value));
          break;
        case "ledswitch":
          this.ledMap = statusMap;
          this.ledService
            ?.getCharacteristic(Characteristic.On)
            .updateValue(Boolean(statusMap.value));
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
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

  _scaled(statusMap, code) {
    if (!statusMap) return 0;
    return statusMap.value / this._getScale(code);
  }

  async _send(commands) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, { commands });
    } catch (error) {
      this.log.error(`[SET] Failed to send sauna command:`, error);
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

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default SaunaAccessory;
