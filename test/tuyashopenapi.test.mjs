import { describe, it } from "node:test";
import assert from "node:assert/strict";

import TuyaSHOpenAPI from "../lib/tuyashopenapi.mjs";
import LogUtil from "../util/logutil.mjs";
import env from "./env.js";

// Integration test: hits the real Tuya cloud, so it only runs once real
// credentials have been filled into test/env.js. Otherwise it is skipped.
const notConfigured =
  !env.accessId || env.accessId === "your_access_id"
    ? "set real credentials in test/env.js to run"
    : false;

describe("TuyaSHOpenAPI", () => {
  it("getDevices() returns a non-empty device list", { skip: notConfigured }, async () => {
    const api = new TuyaSHOpenAPI(
      env.accessId,
      env.accessKey,
      env.username,
      env.password,
      env.countryCode ?? 86,
      env.appSchema ?? "tuyaSmart",
      new LogUtil(console, false),
    );

    const devices = await api.getDevices();
    assert.ok(Array.isArray(devices), "expected an array of devices");
    assert.ok(devices.length > 0, "expected at least one device");
  });
});
