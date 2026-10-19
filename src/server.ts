import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Service } from "./service.js";
import { BridgeError } from "./domain.js";
import { createMcp } from "./mcp.js";
import type { WhatsApp } from "./whatsapp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function createApp(
  service: Service,
  wa: WhatsApp,
  ownerToken: string,
  port: number,
) {
  const app = express();
  app.disable("x-powered-by");
  const base = `http://127.0.0.1:${port}`;
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
  app.use("/owner", (req, res, next) => {
    if (!equal(req.headers.authorization ?? "", `Bearer ${ownerToken}`)) {
      res.sendStatus(401);
      return;
    }
    next();
  });
  app.get("/owner/pairing", (_req, res) => {
    res.json({ state: wa.state, qr: wa.qr });
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
