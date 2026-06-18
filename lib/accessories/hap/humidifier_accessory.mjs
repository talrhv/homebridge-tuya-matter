"use strict";

import BaseAccessory from "./base_accessory.mjs";

class HumidifierAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.AIR_HUMIDIFIER,
      Service.HumidifierDehumidifier,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.targetCode = "humidity_set";
    this.targetRange = this._getRange(this.targetCode) || { min: 0, max: 100, scale: 0 };

    this.switchMap = null;
    this.currentHumidityMap = null;
    this.targetHumidityMap = null;
    this.brightMap = null;

    // אור משני (אופציונלי)
    this.hasLight = this.statusArr.some((s) => s.code === "switch_led");
    this.lightService = this.hasLight
      ? this.homebridgeAccessory.getService(Service.Lightbulb) ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          `${this._sanitizeName(deviceConfig.name)} Light`,
          "humidifier_light",
        )
      : null;
    this.brightRange = this._getRange("bright_value") || { min: 10, max: 1000, scale: 0 };
    this.lightOn = false;

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
          ? Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING
          : Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
      );

    service
      .getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
      .setProps({
        validValues: [
          Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
        ],
      })
      .onGet(
        () => Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
      );

    service
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this._scaled(this.currentHumidityMap, "humidity_current"));

    if (this.statusArr.some((s) => s.code === this.targetCode)) {
      service
        .getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold)
        .onGet(() => this._scaled(this.targetHumidityMap, this.targetCode))
        .onSet(async (value) => {
          const scale = Math.pow(10, this.targetRange.scale || 0);
          await this._send([
            { code: this.targetCode, value: Math.round(value * scale) },
          ]);
          await this._setSprayHumidity();
        });
    }

    this._initLight();
  }

  _initLight() {
    if (!this.lightService) return;
    const { Characteristic } = this.platform.api.hap;

    this.lightService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.lightOn)
      .onSet(async (value) => {
        await this._send([{ code: "switch_led", value: Boolean(value) }]);
      });

    if (this.statusArr.some((s) => s.code === "bright_value")) {
      this.lightService
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this._scaleTuyaToHb(this.brightMap?.value || 0, this.brightRange))
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
            .updateValue(statusMap.value ? 2 : 0);
          break;
        case "humidity_current":
          this.currentHumidityMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .updateValue(this._scaled(statusMap, "humidity_current"));
          break;
        case "humidity_set":
          this.targetHumidityMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.RelativeHumidityHumidifierThreshold)
            .updateValue(this._scaled(statusMap, this.targetCode));
          break;
        case "switch_led":
          if (this.lightService) {
            this.lightOn = Boolean(statusMap.value);
            this.lightService
              .getCharacteristic(Characteristic.On)
              .updateValue(this.lightOn);
          }
          break;
        case "bright_value":
          if (this.lightService) {
            this.brightMap = statusMap;
            this.lightService
              .getCharacteristic(Characteristic.Brightness)
              .updateValue(this._scaleTuyaToHb(statusMap.value, this.brightRange));
          }
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  async _setSprayHumidity() {
    const sprayCode = ["mode", "spray_mode"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    if (!sprayCode) return;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, {
        commands: [{ code: sprayCode, value: "humidity" }],
      });
    } catch (e) {
      /* spray mode optional */
    }
  }

  _scaled(statusMap, code) {
    if (!statusMap) return 0;
    return Math.min(100, Math.max(0, statusMap.value / this._getScale(code)));
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
      this.log.error(`[SET] Failed to send humidifier command:`, error);
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

export default HumidifierAccessory;
