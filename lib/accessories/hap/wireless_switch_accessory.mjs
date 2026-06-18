"use strict";

import BaseAccessory from "./base_accessory.mjs";

class WirelessSwitchAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    // איתור כפתורים: switch_mode1.. או switch1_value..
    const buttonCodes = (deviceConfig.status || [])
      .map((s) => s.code)
      .filter((code) => /switch_mode\d+/.test(code) || /switch\d+_value/.test(code))
      .sort((a, b) => WirelessSwitchAccessory._index(a) - WirelessSwitchAccessory._index(b));

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.PROGRAMMABLE_SWITCH,
      Service.StatelessProgrammableSwitch,
      buttonCodes,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];
    this.buttonCodes = buttonCodes;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    for (const code of this.buttonCodes) {
      const service = this._getServiceByCode(code);
      if (!service) continue;

      service.setCharacteristic(
        Characteristic.ServiceLabelIndex,
        WirelessSwitchAccessory._index(code),
      );
      service
        .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .setProps(this._eventProps(code));
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;
    if (!statusArr) return;

    // אירועים נורים רק על עדכון בזמן אמת, לא בטעינה הראשונית.
    if (isRefresh) {
      for (const statusMap of statusArr) {
        if (!this.buttonCodes.includes(statusMap.code)) continue;
        const event = this._toEvent(statusMap.value);
        if (event === null) continue;

        const service = this._getServiceByCode(statusMap.code);
        if (service) {
          service
            .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
            .updateValue(event);
        }
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _getServiceByCode(code) {
    if (this.buttonCodes.length <= 1) {
      return this.homebridgeAccessory.getService(this.serviceType);
    }
    return this.homebridgeAccessory.getServiceById(this.serviceType, code);
  }

  /**
   * המרת ערך טויה לאירוע HomeKit (0=single, 1=double, 2=long).
   */
  _toEvent(value) {
    const {
      ProgrammableSwitchEvent,
    } = this.platform.api.hap.Characteristic;
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
        return null;
    }
  }

  /**
   * הגבלת סוגי האירועים לפי ה-range המוצהר ב-functions.
   */
  _eventProps(code) {
    const { ProgrammableSwitchEvent } = this.platform.api.hap.Characteristic;
    const func = this.functionArr.find((f) => f.code === code);
    let range = ["single_click", "double_click", "long_press"];
    if (func) {
      try {
        const values = JSON.parse(func.values);
        if (Array.isArray(values.range) && values.range.length) {
          range = values.range;
        }
      } catch (e) {
        /* ignore */
      }
    }

    const single =
      range.includes("click") ||
      range.includes("single_click") ||
      range.includes("1");
    const double = range.includes("double_click");
    const long = range.includes("press") || range.includes("long_press");

    const valid = [];
    if (single) valid.push(ProgrammableSwitchEvent.SINGLE_PRESS);
    if (double) valid.push(ProgrammableSwitchEvent.DOUBLE_PRESS);
    if (long) valid.push(ProgrammableSwitchEvent.LONG_PRESS);

    return valid.length ? { validValues: valid } : {};
  }

  static _index(code) {
    const m = code.match(/(\d+)/);
    return m ? parseInt(m[1]) : 1;
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default WirelessSwitchAccessory;
