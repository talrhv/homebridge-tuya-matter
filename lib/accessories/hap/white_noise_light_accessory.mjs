"use strict";

import BaseAccessory from "./base_accessory.mjs";

class WhiteNoiseLightAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.LIGHTBULB,
      Service.Lightbulb,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.saturationRange = { min: 0, max: 1000 };
    this.brightRange = { min: 0, max: 1000 };

    this.switchLed = null;
    this.colourData = null;
    this.colourObj = { h: 0, s: 0, v: 0 };
    this.musicMap = null;

    this.hasColour = this.statusArr.some((s) => s.code === "colour_data");
    this.musicService = this.statusArr.some((s) => s.code === "switch_music")
      ? this.homebridgeAccessory.getService(Service.Switch) ||
        this.homebridgeAccessory.addService(
          Service.Switch,
          `${this._sanitizeName(deviceConfig.name)} Noise`,
          "white_noise",
        )
      : null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => Boolean(this.switchLed?.value))
      .onSet(async (value) => {
        await this._send([{ code: "switch_led", value: Boolean(value) }]);
      });

    if (this.hasColour) {
      service
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this._scaleTuyaToHb(this.colourObj.v, this.brightRange))
        .onSet(async (value) => {
          this.colourObj.v = this._scaleHbToTuya(value, this.brightRange);
          await this._sendColour();
        });

      service
        .getCharacteristic(Characteristic.Hue)
        .onGet(() => this.colourObj.h || 0)
        .onSet(async (value) => {
          this.colourObj.h = value;
          await this._sendColour();
        });

      service
        .getCharacteristic(Characteristic.Saturation)
        .onGet(() => this._scaleTuyaToHb(this.colourObj.s, this.saturationRange))
        .onSet(async (value) => {
          this.colourObj.s = this._scaleHbToTuya(value, this.saturationRange);
          await this._sendColour();
        });
    }

    if (this.musicService) {
      this.musicService
        .getCharacteristic(Characteristic.On)
        .onGet(() => Boolean(this.musicMap?.value))
        .onSet(async (value) => {
          await this._send([{ code: "switch_music", value: Boolean(value) }]);
        });
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "switch_led":
          this.switchLed = statusMap;
          this.service
            .getCharacteristic(Characteristic.On)
            .updateValue(Boolean(statusMap.value));
          break;
        case "colour_data":
          this.colourData = statusMap;
          this.colourObj = this._parseColour(statusMap.value);
          this.service
            .getCharacteristic(Characteristic.Hue)
            .updateValue(this.colourObj.h);
          this.service
            .getCharacteristic(Characteristic.Saturation)
            .updateValue(
              this._scaleTuyaToHb(this.colourObj.s, this.saturationRange),
            );
          this.service
            .getCharacteristic(Characteristic.Brightness)
            .updateValue(this._scaleTuyaToHb(this.colourObj.v, this.brightRange));
          break;
        case "switch_music":
          this.musicMap = statusMap;
          this.musicService
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

  _parseColour(value) {
    if (!value) return { h: 0, s: 0, v: 0 };
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async _sendColour() {
    await this._send([{ code: "colour_data", value: { ...this.colourObj } }]);
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
      this.log.error(`[SET] Failed to send white noise light command:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default WhiteNoiseLightAccessory;
