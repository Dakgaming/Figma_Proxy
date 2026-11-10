import "dotenv/config";
import path from "node:path";

/**
 * Accepts either a raw Figma file key or a full URL and extracts the key.
 * Works for /design/, /file/, /board/ and /slides/ URL shapes.
 */
export function parseFileKey(input: unknown): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/(?:design|file|board|slides)\/([A-Za-z0-9]{10,})/);
  if (match) return match[1];
  return trimmed;
}

export const config = {
  port: Number(process.env.PORT ?? 8741),
  callbackPort: Number(process.env.CALLBACK_PORT ?? 8742),
  callbackHost: process.env.CALLBACK_HOST?.trim() || "127.0.0.1",
  proxyApiKey: process.env.PROXY_API_KEY?.trim() ?? "",
  mcpUrl: process.env.FIGMA_MCP_URL?.trim() || "https://mcp.figma.com/mcp",
  defaultFileKey: parseFileKey(process.env.FIGMA_FILE_KEY ?? process.env.FIGMA_FILE_URL),
  // Figma image model used when the request doesn't name one.
  // Empty = let Figma pick its default.
  figmaModel: process.env.FIGMA_MODEL?.trim() || "",
  // Generated nodes are deleted from the Figma file after download to keep the
  // file clutter-free. Set FIGMA_KEEP_IMAGES=1 to keep them on the canvas.
  keepImages: process.env.FIGMA_KEEP_IMAGES === "1",
  // Verbose logging of raw MCP responses (for diagnosing quality/URL issues).
  debug: process.env.DEBUG_FIGMA === "1",
  modelId: process.env.MODEL_ID?.trim() || "figma-image-1",
  tokenStorePath: path.resolve(process.env.TOKEN_STORE ?? ".figma-auth.json"),
};
