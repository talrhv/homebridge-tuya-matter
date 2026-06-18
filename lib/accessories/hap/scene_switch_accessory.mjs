"use strict";

import BaseAccessory from "./base_accessory.mjs";

const RESET_DELAY_MS = 150;

class SceneSwitchAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig, deviceData) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SWITCH,
      Service.Switch,
      deviceData.subType,
    );

    this.statusArr = deviceConfig.status || [];
    this.subTypeArr = deviceData.subType || [];

    this.states = new Map();

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    for (const dpCode of this.subTypeArr) {
      const service = this._getServiceByCode(dpCode);
      if (!service) continue;

      service
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.states.get(dpCode) || false)
        .onSet(async (value) => {
          if (value) {
            await this._triggerScene(dpCode, service);
          }
        });
    }
  }

  /**
   * הפעלת סצנה: שליחת הפקודה ואיפוס מיידי של הכפתור (Momentary).
   */
  async _triggerScene(dpCode, service) {
    const { Characteristic, HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, {
        commands: [{ code: dpCode, value: true }],
      });

      this.states.set(dpCode, false);
      setTimeout(() => {
        service.getCharacteristic(Characteristic.On).updateValue(false);
      }, RESET_DELAY_MS);
    } catch (error) {
      this.log.error(`[SCENE][${dpCode}] Failed to trigger:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;
    if (!statusArr) return;

    for (const dpCode of this.subTypeArr) {
      const status = statusArr.find((item) => item.code === dpCode);
      if (!status) continue;

      // כפתורי סצנה הם רגעיים — תמיד מציגים כבוי.
      this.states.set(dpCode, false);
      const service = this._getServiceByCode(dpCode);
      if (service && isRefresh && Boolean(status.value)) {
        service.getCharacteristic(Characteristic.On).updateValue(true);
        setTimeout(() => {
          service.getCharacteristic(Characteristic.On).updateValue(false);
        }, RESET_DELAY_MS);
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _getServiceByCode(dpCode) {
    if (this.subTypeArr.length <= 1) {
      return this.homebridgeAccessory.getService(this.serviceType);
    }
    return this.homebridgeAccessory.getServiceById(this.serviceType, dpCode);
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default SceneSwitchAccessory;
