import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  DEFAULT_CONNECTION_CONFIG,
  generateRegistrationNode,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";

test("pairing advertises shared group history in the actual registration bytes", () => {
  const payload = generateRegistrationNode(initAuthCreds(), {
    ...DEFAULT_CONNECTION_CONFIG,
    syncFullHistory: true,
  });
  assert.ok(payload.devicePairingData?.deviceProps);
  const props = proto.DeviceProps.decode(payload.devicePairingData.deviceProps);
  assert.equal(props.historySyncConfig?.supportGroupHistory, true);
  assert.equal(props.requireFullSync, true);
  assert.equal(props.platformType, proto.DeviceProps.PlatformType.CHROME);
});

test("the pinned Baileys capability patch can be reapplied without changing the installed source", () => {
  const require = createRequire(import.meta.url);
  const path = join(
    dirname(require.resolve("@whiskeysockets/baileys")),
    "Utils/validate-connection.js",
  );
  const before = readFileSync(path, "utf8");
  for (let n = 0; n < 2; n++)
    execFileSync(process.execPath, ["scripts/patch-baileys.mjs"]);
  assert.equal(readFileSync(path, "utf8"), before);
});
