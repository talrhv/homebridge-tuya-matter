import { describe, it } from "node:test";
import assert from "node:assert/strict";

import TuyaSHOpenAPI from "../lib/tuyashopenapi.mjs";
import TuyaOpenMQ from "../lib/tuyamqttapi.mjs";
import LogUtil from "../util/logutil.mjs";
import env from "./env.js";

// Integration test: opens a live MQTT connection to the Tuya cloud, so it only
// runs once real credentials have been filled into test/env.js.
const notConfigured =
  !env.accessId || env.accessId === "your_access_id"
    ? "set real credentials in test/env.js to run"
    : false;

describe("TuyaOpenMQ", () => {
  it("connects to the realtime message broker", { skip: notConfigured }, async (t) => {
    t.timeout = 5000;

    const log = new LogUtil(console, false);
    const api = new TuyaSHOpenAPI(
      env.accessId,
      env.accessKey,
      env.username,
      env.password,
      env.countryCode ?? 86,
      env.appSchema ?? "tuyaSmart",
      log,
    );
    const mq = new TuyaOpenMQ(api, "1.0", log);

    await api._refreshAccessTokenIfNeed("");

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("MQTT connection timed out")),
        4000,
      );
      TuyaOpenMQ.prototype._onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      mq.start();
    });

    assert.ok(true, "MQTT connected");
    mq.stop?.();
  });
});
