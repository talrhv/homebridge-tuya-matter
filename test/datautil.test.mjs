import { describe, it } from "node:test";
import assert from "node:assert/strict";

import DataUtil from "../util/datautil.mjs";

describe("DataUtil", () => {
  const util = new DataUtil();

  it("getSubService() collects only boolean switch codes, numerically sorted", () => {
    const { subType } = util.getSubService([
      { code: "switch_1", value: true },
      { code: "switch_led", value: false }, // boolean -> included (no digits -> sorts first)
      { code: "countdown_1", value: 0 }, // not a switch -> ignored
      { code: "switch_2", value: true },
      { code: "bright_value", value: 50 }, // not a switch -> ignored
    ]);

    assert.deepEqual(subType, ["switch_led", "switch_1", "switch_2"]);
  });

  it("getSubService() ignores switch codes whose value is not boolean", () => {
    const { subType } = util.getSubService([
      { code: "switch", value: "on" },
      { code: "switch_mode", value: 1 },
    ]);

    assert.deepEqual(subType, []);
  });

  it("getSubService() tolerates non-array input", () => {
    assert.deepEqual(util.getSubService(null), { subType: [] });
    assert.deepEqual(util.getSubService(undefined), { subType: [] });
  });

  it("getFriendlyName() derives a label from the trailing index", () => {
    assert.equal(util.getFriendlyName("switch_2"), "Switch 2");
    assert.equal(util.getFriendlyName("switch"), "Switch");
  });
});
