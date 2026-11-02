import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ServerInput } from "./contract.js";

export const REQUEST_TIMEOUT_MS = 20_000;
export async function openClient(server: ServerInput, signal: AbortSignal) {
  signal.throwIfAborted();
  const client = new Client({ name: "bb-mcp-hub", version: "0.1.0" });
  const transport =
    server.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(server.url!), {
          requestInit: {
            headers: server.bearerToken
              ? { Authorization: `Bearer ${server.bearerToken}` }
              : {},
          },
        })
      : new StdioClientTransport({
          command: server.command!,
          args: server.args ?? [],
          env: server.env,
          stderr: "ignore",
          maxBufferSize: 2_000_000,
        });
  const close = async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await client.connect(transport, { signal, timeout: REQUEST_TIMEOUT_MS });
    signal.throwIfAborted();
    return { client, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
