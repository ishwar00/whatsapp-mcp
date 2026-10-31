import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

const readTools = new Set([
  "get_status",
  "get_history_status",
  "get_replies",
  "list_chats",
  "list_participants",
  "read_messages",
  "search_messages",
  "get_context",
  "get_attachment",
  "list_drafts",
  "get_operation",
]);

// Forward tools to the local daemon; approval belongs to the client.
export function createStdioProxy(url: string, token: string) {
  const server = new Server(
    { name: "whatsapp-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  let upstream: Promise<Client> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  function connect() {
    if (upstream) return upstream;
    const pending = (async () => {
      const client = new Client(
        { name: "whatsapp-stdio-adapter", version: "0.1.0" },
        { capabilities: {} },
      );
      client.onclose = () => {
        if (upstream === pending) upstream = null;
      };
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    })();
    upstream = pending;
    void pending.catch(() => {
      if (upstream === pending) upstream = null;
    });
    return pending;
  }
  async function withConnection<T>(
    action: (client: Client) => Promise<T>,
    retryRead = false,
  ): Promise<T> {
    const connection = connect();
    const client = await connection;
    try {
      return await action(client);
    } catch (error) {
      if (
        upstream === connection &&
        (!(error instanceof StreamableHTTPError) || error.code !== 404)
      )
        throw error;
      if (upstream === connection) upstream = null;
      await client.close();
      if (retryRead) return withConnection(action);
      throw error;
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    withConnection((client) => client.listTools(), true),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const action = async () => {
      if (extra.signal.aborted) throw new Error("Request cancelled");
      {
        return await withConnection(
          (client) =>
            client.callTool(request.params, undefined, {
              signal: extra.signal,
              timeout: 150_000,
            }),
          readTools.has(request.params.name),
        );
      }
    };
    if (readTools.has(request.params.name)) return action();
    // Mutations stay ordered; reads must not wait for a send approval.
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    return result;
  });
  const close = server.close.bind(server);
  server.close = async () => {
    if (upstream) await (await upstream.catch(() => null))?.close();
    await close();
  };
  server.onclose = () => {
    if (upstream)
      void upstream.then((client) => client.close()).catch(() => undefined);
  };
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const token = process.env.WHATSAPP_BRIDGE_TOKEN;
  if (!token) throw new Error("WHATSAPP_BRIDGE_TOKEN is required");
  const server = createStdioProxy(
    process.env.WHATSAPP_BRIDGE_URL ?? "http://127.0.0.1:3210/mcp",
    token,
  );
  await server.connect(new StdioServerTransport());
}
