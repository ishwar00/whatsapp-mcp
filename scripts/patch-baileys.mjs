import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const entry = require.resolve("@whiskeysockets/baileys");
const { version } = JSON.parse(
  readFileSync(join(dirname(entry), "../package.json"), "utf8"),
);
if (version !== "7.0.0-rc14") {
  throw new Error(
    "Review the group-history capability patch when upgrading Baileys",
  );
}

// rc14 otherwise tells the phone not to sync messages imported from shared group history.
const path = join(dirname(entry), "Utils/validate-connection.js");
const source = readFileSync(path, "utf8");
const before = "supportGroupHistory: false,";
const after = "supportGroupHistory: true,";
if (source.includes(before)) {
  if (source.split(before).length !== 2 || source.includes(after)) {
    throw new Error("Unexpected Baileys group-history capability declaration");
  }
  writeFileSync(path, source.replace(before, after));
} else if (!source.includes(after) || source.split(after).length !== 2) {
  throw new Error("Baileys group-history capability patch no longer matches");
}
