import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import open from "open";
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { config } from "../config.js";

interface StoredState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

/**
 * Persists OAuth client registration and tokens to disk so the browser
 * login only has to happen once; refreshes are handled by the SDK.
 * The loopback callback server is owned here so it is guaranteed to be
 * listening before the browser opens.
 */
export class FigmaAuthProvider implements OAuthClientProvider {
  private readonly file = config.tokenStorePath;
  private data: StoredState = {};
  private pendingCallback?: Promise<string>;

  constructor() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredState;
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }

  get redirectUrl(): string {
    return `http://${config.callbackHost}:${config.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      // Figma's remote MCP server allowlists client names at registration and
      // rejects everything else with 403. Registering under a catalog client's
      // name is the only way a self-hosted client gets the mcp:connect scope.
      client_name: "Claude Code",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:connect",
    };
  }

  get authenticated(): boolean {
    return Boolean(this.data.tokens?.access_token);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.data.clientInformation = info;
    this.save();
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens;
    this.save();
  }

  state(): string {
    const state = randomUUID();
    this.data.state = state;
    this.save();
    return state;
  }

  get issuedState(): string | undefined {
    return this.data.state;
  }

  codeVerifier(): string {
    return this.data.codeVerifier ?? "";
  }

  saveCodeVerifier(verifier: string): void {
    this.data.codeVerifier = verifier;
    this.save();
  }

  private callbackServer?: http.Server;
  private callbackPromise?: Promise<string>;

  redirectToAuthorization(url: URL): void {
    console.log("[auth] Opening browser for Figma authorization...");
    console.log(`[auth] If the browser did not open, visit:\n       ${url.toString()}`);
    this.ensureCallbackServer()
      .then(() => open(url.toString(), { wait: false }).catch(() => {}))
      .catch((err) =>
        console.error("[auth] Callback server failed:", err instanceof Error ? err.message : err),
      );
  }

  /** Resolves with the authorization code captured from the browser redirect. */
  async nextCallback(timeoutMs: number): Promise<string> {
    const pending = this.ensureCallbackServer();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for the Figma authorization callback")),
        timeoutMs,
      ),
    );
    try {
      return await Promise.race([pending, timeout]);
    } catch (err) {
      // Free the port so a later flow can bind it again.
      this.closeCallbackServer();
      throw err;
    }
  }

  /** Starts the loopback callback server exactly once; later flows reuse it. */
  private ensureCallbackServer(): Promise<string> {
    if (this.callbackPromise) return this.callbackPromise;
    this.callbackPromise = new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (requestUrl.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");

        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<html><body style='font-family:sans-serif'><h3>Figma authorization received.</h3>" +
            "You can close this tab and return to the terminal.</body></html>",
        );

        const finish = (fn: () => void) => {
          this.closeCallbackServer();
          fn();
        };
        if (error) return finish(() => reject(new Error(`Figma authorization failed: ${error}`)));
        if (!code) return finish(() => reject(new Error("Authorization callback missing code")));
        if (state && this.issuedState && state !== this.issuedState) {
          return finish(() => reject(new Error("State mismatch in authorization callback")));
        }
        finish(() => resolve(code));
      });

      server.on("error", (err) => {
        this.callbackServer = undefined;
        this.callbackPromise = undefined;
        reject(err);
      });
      server.listen(config.callbackPort, config.callbackHost, () => {
        this.callbackServer = server;
      });
    });
    return this.callbackPromise;
  }

  private closeCallbackServer(): void {
    this.callbackServer?.close(() => {});
    this.callbackServer = undefined;
    this.callbackPromise = undefined;
  }
}
