import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { FigmaAuthProvider } from "../auth/provider.js";
import { config } from "../config.js";

/** Narrow view of MCP tool result content; avoids coupling to SDK type churn. */
export interface LooseContent {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content?: LooseContent[];
  isError?: boolean;
}

export class FigmaMcpError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export class FigmaMcp {
  private provider = new FigmaAuthProvider();
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private tools = new Map<string, Tool>();
  // Serialize tool calls: one canvas at a time, and generate_image is expensive.
  private queue: Promise<unknown> = Promise.resolve();

  get authenticated(): boolean {
    return this.provider.authenticated;
  }

  hasConnectedClient(): boolean {
    return this.client !== null;
  }

  async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.connect().catch((err) => {
        this.connecting = null;
        throw err;
      });
    }
    return this.connecting;
  }

  async toolSchema(name: string): Promise<Tool | undefined> {
    await this.ensureConnected();
    return this.tools.get(name);
  }

  /** Lists tools and refreshes the cached schemas. */
  async listTools(): Promise<Tool[]> {
    const client = await this.ensureConnected();
    const { tools } = await client.listTools();
    this.tools = new Map(tools.map((t) => [t.name, t]));
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.ensureConnected();
    const run = async (): Promise<ToolResult> => {
      const result = (await client.callTool(
        { name, arguments: args },
        undefined,
        // generate_image can take a while; progress notifications keep it alive.
        { timeout: 300_000, resetTimeoutOnProgress: true },
      )) as ToolResult;
      if (result.isError) {
        throw new FigmaMcpError(`Figma tool "${name}" failed: ${resultText(result) || "unknown error"}`);
      }
      return result;
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.catch(() => {});
    return chained;
  }

  private async connect(): Promise<Client> {
    const first = await this.tryConnect();
    if (first) return first;
    // UnauthorizedError: the transport already ran OAuth discovery, registered
    // the client, and redirected the browser (provider.redirectToAuthorization).
    // Complete that in-flight flow with the code it captures — do NOT start a
    // second flow, or it will try to rebind the callback port (EADDRINUSE).
    const code = await this.provider.nextCallback(5 * 60_000);
    await auth(this.provider, { serverUrl: config.mcpUrl, authorizationCode: code });
    console.log("[auth] Figma authorization complete");
    const second = await this.tryConnect();
    if (!second) {
      throw new FigmaMcpError("Figma MCP still requires authorization after completing the OAuth flow", 401);
    }
    return second;
  }

  private async tryConnect(): Promise<Client | null> {
    const client = new Client({ name: "figma-openai-proxy", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
      authProvider: this.provider,
    });
    try {
      await client.connect(transport);
    } catch (err) {
      if (err instanceof UnauthorizedError) return null;
      throw err;
    }
    this.client = client;
    await this.refreshTools(client);
    return client;
  }

  private async refreshTools(client: Client): Promise<void> {
    const { tools } = await client.listTools();
    this.tools = new Map(tools.map((t) => [t.name, t]));
    console.log(`[mcp] Connected. Tools: ${tools.map((t) => t.name).join(", ")}`);
  }
}

export function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

export const figma = new FigmaMcp();
