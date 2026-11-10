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
  // Figma's models output at most 1536px on the long edge, so a requested size
  // larger than that is delivered by upscaling (Lanczos + light sharpen).
  // FIGMA_UPSCALE=0 disables it — the native pixels are then returned instead.
  upscale: process.env.FIGMA_UPSCALE !== "0",
  // Format used when a request doesn't set output_format.
  outputFormat: parseOutputFormat(process.env.FIGMA_OUTPUT_FORMAT),
  // Size used when a request omits "size" (e.g. FIGMA_DEFAULT_SIZE=1920x1080).
  defaultSize: parseSizePair(process.env.FIGMA_DEFAULT_SIZE),
  modelId: process.env.MODEL_ID?.trim() || "figma-image-1",
  tokenStorePath: path.resolve(process.env.TOKEN_STORE ?? ".figma-auth.json"),
};

function parseOutputFormat(value: string | undefined): "png" | "jpeg" | "webp" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "jpeg" || normalized === "jpg") return "jpeg";
  if (normalized === "webp") return "webp";
  return "png";
}

function parseSizePair(value: string | undefined): { width: number; height: number } | undefined {
  const match = value?.trim().match(/^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/);
  if (!match) return undefined;
  const width = Math.min(Number(match[1]), 4096);
  const height = Math.min(Number(match[2]), 4096);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
