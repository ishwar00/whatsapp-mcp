import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import QRCode from "qrcode";
import { Service } from "./service.js";
import { BridgeError } from "./domain.js";
import { createMcp } from "./mcp.js";
import type { WhatsApp } from "./whatsapp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
function optional<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createApp(
  service: Service,
  wa: WhatsApp,
  ownerToken: string,
  port: number,
) {
  const app = express();
  app.disable("x-powered-by");
  const base = `http://127.0.0.1:${port}`;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  app.use((req, res, next) => {
    if (
      req.headers.host !== `127.0.0.1:${port}` &&
      req.headers.host !== `localhost:${port}`
    ) {
      res.sendStatus(403);
      return;
    }
    if (
      req.headers.origin &&
      req.headers.origin !== base &&
      req.headers.origin !== `http://localhost:${port}`
    ) {
      res.sendStatus(403);
      return;
    }
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: "8mb" }));
  const rates = new Map<string, { start: number; count: number }>();
  app.use((req, res, next) => {
    const key = req.headers.authorization ?? req.ip ?? "local";
    const now = Date.now();
    const previous = rates.get(key);
    const entry =
      previous && now - previous.start < 60000
        ? previous
        : { start: now, count: 0 };
    entry.count++;
    rates.set(key, entry);
    if (rates.size > 5000) rates.clear();
    if (entry.count > 180) {
      res.sendStatus(429);
      return;
    }
    next();
  });
  // Keep MCP sessions isolated per authenticated principal.
  const mcpSessions = new Map<
    string,
    {
      principalId: string;
      transport: StreamableHTTPServerTransport;
      server: ReturnType<typeof createMcp>;
      lastUsed: number;
      activeRequests: number;
    }
  >();
  const reapSessions = setInterval(() => {
    for (const [id, session] of mcpSessions) {
      if (
        session.activeRequests === 0 &&
        Date.now() - session.lastUsed > 5 * 60_000
      ) {
        mcpSessions.delete(id);
        void session.server.close();
      }
    }
  }, 60_000);
  reapSessions.unref();
  app.all("/mcp", async (req, res, next) => {
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    const principal = service.store.principal(token);
    if (!principal) {
      res.sendStatus(401);
      return;
    }
    try {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId) {
        const session =
          typeof sessionId === "string" ? mcpSessions.get(sessionId) : null;
        if (!session || session.principalId !== principal.id) {
          res.sendStatus(404);
          return;
        }
        session.lastUsed = Date.now();
        session.activeRequests++;
        try {
          await session.transport.handleRequest(req, res, req.body);
        } finally {
          session.activeRequests--;
          session.lastUsed = Date.now();
        }
        return;
      }
      if (req.method !== "POST") {
        res.sendStatus(405);
        return;
      }
      const initializing = isInitializeRequest(req.body);
      if (initializing && mcpSessions.size >= 100) {
        const oldestIdle = [...mcpSessions.entries()]
          .filter(([, session]) => session.activeRequests === 0)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!oldestIdle) {
          res.sendStatus(429);
          return;
        }
        mcpSessions.delete(oldestIdle[0]);
        await oldestIdle[1].server.close();
      }
      const server = createMcp(service, wa, principal);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: initializing ? randomUUID : undefined,
        enableJsonResponse: !initializing,
        onsessioninitialized: (id) => {
          mcpSessions.set(id, {
            principalId: principal.id,
            transport,
            server,
            lastUsed: Date.now(),
            activeRequests: 0,
          });
        },
        onsessionclosed: (id) => {
          mcpSessions.delete(id);
        },
      });
      // Stateless requests remain supported.
      if (!initializing)
        res.on("close", () => {
          void server.close();
        });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      next(e);
    }
  });
  app.post("/owner/login", (req, res) => {
    const input = z.object({ token: z.string() }).safeParse(req.body);
    if (!input.success || !equal(input.data.token, ownerToken)) {
      res.sendStatus(401);
      return;
    }
    for (const [key, v] of sessions)
      if (v.expires < Date.now()) sessions.delete(key);
    if (sessions.size >= 20) sessions.clear();
    const id = secret(),
      csrf = secret();
    sessions.set(id, { csrf, expires: Date.now() + 8 * 3600000 });
    res.setHeader(
      "Set-Cookie",
      `owner=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
    );
    res.json({ csrf });
  });
  app.use("/owner", (req, res, next) => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("owner="))
      ?.slice(6);
    const session = cookie ? sessions.get(cookie) : undefined;
    if (!session || session.expires < Date.now()) {
      res.sendStatus(401);
      return;
    }
    if (
      req.method !== "GET" &&
      (!req.headers.origin ||
        !equal(String(req.headers["x-csrf-token"] ?? ""), session.csrf))
    ) {
      res.sendStatus(403);
      return;
    }
    res.locals.csrf = session.csrf;
    next();
  });
  app.get("/owner/pairing", (_req, res) => {
    res.json({ state: wa.state, qr: wa.qr });
  });
  app.get("/owner/state", async (_req, res) => {
    res.json({
      csrf: res.locals.csrf,
      state: wa.state,
      qr: wa.qr ? await QRCode.toDataURL(wa.qr) : null,
      chats: service.store.chats().map(({ jid, ...c }) => c),
      clients: service.store.clients().map(({ tokenHash, ...c }) => c),
      drafts: service.store.drafts().map((d) => ({
        ...d,
        chatName: service.store.chat(d.input.chat_id).name,
        recipient: service.store.chat(d.input.chat_id).jid,
        reply: optional(() =>
          d.input.reply_to_message_id
            ? service.store.message(d.input.reply_to_message_id)
            : null,
        ),
        mentions: d.input.mention_ids.map((id) =>
          service.store.get("participant", id),
        ),
        attachments: d.input.attachment_ids
          .map((id) => optional(() => service.store.media(id).meta))
          .filter(Boolean),
        context: service.store
          .messages([d.input.chat_id])
          .filter((m) => m.observedAt > d.createdAt)
          .slice(-10),
      })),
    });
  });
  app.post("/owner/history", async (req, res) => {
    const input = z
      .object({
        chat_id: z.string(),
        count: z.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.body);
    res.json(await wa.requestHistory(input.chat_id, input.count));
  });
  app.post("/owner/clients", (req, res) => {
    const q = z
      .object({
        name: z.string().min(1).max(100),
        can_draft: z.boolean(),
        can_send: z.boolean().default(false),
      })
      .parse(req.body);
    const token = secret();
    const id = service.store.uuid("client");
    service.store.put("client", id, {
      id,
      name: q.name,
      tokenHash: importHash(token),
      canDraft: q.can_draft,
      canSend: q.can_send,
      enabled: true,
    });
    res.json({ id, token });
  });
  app.post("/owner/clients/:id/access", (req, res) => {
    const q = z
      .object({
        name: z.string().min(1).max(100),
        can_draft: z.boolean(),
        can_send: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const client = service.store
      .clients()
      .find((c) => c.id === req.params.id && c.enabled);
    if (!client) throw new BridgeError("not_found_or_not_permitted");
    service.store.put("client", client.id, {
      ...client,
      name: q.name,
      canDraft: q.can_draft,
      canSend: q.can_send ?? client.canSend,
    });
    res.json({ ok: true });
  });
  app.post("/owner/revoke", (req, res) => {
    const q = z.object({ client_id: z.string() }).parse(req.body);
    const client = service.store.clients().find((c) => c.id === q.client_id);
    if (!client) throw new BridgeError("not_found_or_not_permitted");
    service.store.put("client", client.id, { ...client, enabled: false });
    res.json({ ok: true });
  });
  app.post("/owner/reject", (req, res) => {
    const q = z.object({ draft_id: z.string() }).parse(req.body);
    const draft = service.store.draft(q.draft_id);
    if (draft.status === "pending")
      service.store.saveDraft({ ...draft, status: "rejected" });
    res.json({ ok: true });
  });
  app.get("/owner/media/:id", (req, res) => {
    const id = z
      .string()
      .regex(/^attachment_[a-zA-Z0-9-]+$/)
      .parse(req.params.id);
    const { meta, data } = service.store.media(id);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${meta.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
    );
    res.type(meta.mime).send(data);
  });
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) return;
      res.status(error instanceof BridgeError ? 409 : 400).json({
        error: error instanceof BridgeError ? error.code : "invalid_request",
      });
    },
  );
  return app;
}
import { hash as importHash } from "./store.js";
