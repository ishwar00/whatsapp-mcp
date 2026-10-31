import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  Curve,
  DEFAULT_CONNECTION_CONFIG,
  generateSignalPubKey,
  addTransactionCapability,
} from "@whiskeysockets/baileys";
import { Store } from "../src/store.js";
import { WhatsApp } from "../src/whatsapp.js";

test("real Signal sessions encrypt and decrypt after SQLite reload", async () => {
  const dirs = [
    mkdtempSync(join(tmpdir(), "wa-signal-a-")),
    mkdtempSync(join(tmpdir(), "wa-signal-b-")),
  ];
  const stores = dirs.map((dir) => new Store(dir));
  const endpoints = stores.map((store) => {
    const wa = new WhatsApp(store),
      auth = wa.auth();
    store.put("auth", "creds", auth.creds);
    return {
      wa,
      auth,
      repo: DEFAULT_CONNECTION_CONFIG.makeSignalRepository(
        {
          ...auth,
          keys: addTransactionCapability(
            auth.keys,
            pino({ level: "silent" }),
            DEFAULT_CONNECTION_CONFIG.transactionOpts,
          ),
        },
        pino({ level: "silent" }),
      ),
    };
  });
  try {
    const [a, b] = endpoints;
    assert.ok(a && b);
    const aJid = "11111@s.whatsapp.net",
      bJid = "22222@s.whatsapp.net";
    const preKey = Curve.generateKeyPair();
    await b.auth.keys.set({ "pre-key": { "1": preKey } });
    await a.repo.injectE2ESession({
      jid: bJid,
      session: {
        registrationId: b.auth.creds.registrationId,
        identityKey: generateSignalPubKey(
          b.auth.creds.signedIdentityKey.public,
        ),
        signedPreKey: {
          keyId: b.auth.creds.signedPreKey.keyId,
          publicKey: generateSignalPubKey(
            b.auth.creds.signedPreKey.keyPair.public,
          ),
          signature: b.auth.creds.signedPreKey.signature,
        },
        preKey: { keyId: 1, publicKey: generateSignalPubKey(preKey.public) },
      },
    });
    assert.equal((await a.repo.validateSession(bJid)).exists, true);
    const first = await a.repo.encryptMessage({
      jid: bJid,
      data: Buffer.from("history request"),
    });
    assert.equal(
      Buffer.from(
        await b.repo.decryptMessage({ jid: aJid, ...first }),
      ).toString(),
      "history request",
    );
    for (const endpoint of endpoints) {
      endpoint.repo.close();
      endpoint.wa.stop();
    }
    for (const store of stores) store.close();
    stores.splice(0, stores.length, ...dirs.map((dir) => new Store(dir)));
    const reloaded = stores.map((store) => {
      const wa = new WhatsApp(store);
      return {
        wa,
        repo: DEFAULT_CONNECTION_CONFIG.makeSignalRepository(
          {
            ...wa.auth(),
            keys: addTransactionCapability(
              wa.auth().keys,
              pino({ level: "silent" }),
              DEFAULT_CONNECTION_CONFIG.transactionOpts,
            ),
          },
          pino({ level: "silent" }),
        ),
      };
    });
    endpoints.splice(0, endpoints.length);
    try {
      const [a2, b2] = reloaded;
      assert.ok(a2 && b2);
      assert.equal((await a2.repo.validateSession(bJid)).exists, true);
      const response = await b2.repo.encryptMessage({
        jid: aJid,
        data: Buffer.from("history response"),
      });
      assert.equal(response.type, "msg");
      assert.equal(
        Buffer.from(
          await a2.repo.decryptMessage({ jid: bJid, ...response }),
        ).toString(),
        "history response",
      );
    } finally {
      for (const endpoint of reloaded) {
        endpoint.repo.close();
        endpoint.wa.stop();
      }
    }
  } finally {
    for (const endpoint of endpoints) {
      endpoint.repo.close();
      endpoint.wa.stop();
    }
    for (const store of stores) store.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
