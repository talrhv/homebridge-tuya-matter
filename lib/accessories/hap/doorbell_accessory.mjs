"use strict";

import BaseAccessory from "./base_accessory.mjs";

class DoorbellAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.PROGRAMMABLE_SWITCH,
      Service.StatelessProgrammableSwitch,
    );

    this.statusArr = deviceConfig.status || [];
    this.callCode = "doorbell_call";

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    // הפעמון משדר אירועים בלבד; אין צורך ב-onGet.
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;
    if (!statusArr) return;

    if (isRefresh) {
      for (const statusMap of statusArr) {
        if (statusMap.code !== this.callCode) continue;
        const event = this._toEvent(statusMap.value);
        if (event === null) continue;
        this.service
          .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
          .updateValue(event);
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _toEvent(value) {
    const { ProgrammableSwitchEvent } = this.platform.api.hap.Characteristic;
    switch (value) {
      case "click":
      case "single_click":
      case "1":
        return ProgrammableSwitchEvent.SINGLE_PRESS;
      case "double_click":
        return ProgrammableSwitchEvent.DOUBLE_PRESS;
      case "press":
      case "long_press":
        return ProgrammableSwitchEvent.LONG_PRESS;
      default:
        // ערך לא מזוהה (למשל boolean) מטופל כצלצול בודד.
        return value ? ProgrammableSwitchEvent.SINGLE_PRESS : null;
    }
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default DoorbellAccessory;
