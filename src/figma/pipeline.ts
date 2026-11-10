import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { figma, FigmaMcpError, resultText, type ToolResult } from "./client.js";
import { config } from "../config.js";

export interface GeneratedImage {
  prompt: string;
  model?: string;
  fileKey?: string;
  nodeId?: string;
  bytes: Buffer;
  contentType: string;
}

type JsonSchema = {
  properties?: Record<string, { type?: string }>;
  required?: string[];
};

/**
 * Keeps only the arguments the tool's input schema actually declares.
 * Figma's tool signatures evolve; this tolerates renames and additions.
 */
export function filterBySchema(
  schema: Tool | JsonSchema | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (schema as JsonSchema | undefined)?.properties;
  if (!properties) return { ...values };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (key in properties) out[key] = value;
  }
  return out;
}

/** Finds the name of the first array-typed property in a schema. */
function arrayProperty(schema: Tool | JsonSchema | undefined): string | undefined {
  const properties = (schema as JsonSchema | undefined)?.properties;
  if (!properties) return undefined;
  for (const [key, value] of Object.entries(properties)) {
    if (value?.type === "array") return key;
  }
  return undefined;
}

function pick(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Best-effort parse of the first JSON object found in a tool result. */
function parseToolJson(result: ToolResult): Record<string, unknown> {
  const text = resultText(result);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return flatten(parsed);
  } catch {
    // fall through to substring search
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object") return flatten(parsed);
    } catch {
      // ignore
    }
  }
  return {};
}

/** Unwraps single-level nesting like { result: {...} } or { data: {...} }. */
function flatten(value: unknown): Record<string, unknown> {
  let current = value as Record<string, unknown>;
  for (let i = 0; i < 3; i++) {
    if (
      current &&
      typeof current === "object" &&
      !("nodeId" in current || "node_id" in current || "url" in current)
    ) {
      const nested = ["result", "data", "output"].find((k) => current[k] && typeof current[k] === "object");
      if (nested) current = current[nested] as Record<string, unknown>;
      else break;
    } else break;
  }
  return current;
}

function extractFirstUrl(result: ToolResult): string | undefined {
  const text = resultText(result);
  const match = text.match(/https?:\/\/[^\s"'<>\\)\]]+/);
  return match?.[0];
}

/** Pulls the full-resolution download URL out of a parsed generate_image response. */
function extractImageUrl(obj: Record<string, unknown>): string | undefined {
  const urls = collectUrls(obj);
  // Prefer URLs found under an image-ish key; the response may also carry
  // preview links, file links, or curl targets we don't want.
  return (urls.find((u) => /image/i.test(u.path)) ?? urls[0])?.url;
}

/** Depth-first scan for URL strings, remembering the key path they came from. */
function collectUrls(
  value: unknown,
  path = "",
  out: Array<{ path: string; url: string }> = [],
): Array<{ path: string; url: string }> {
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value)) out.push({ path, url: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectUrls(item, `${path}[${i}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectUrls(child, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

export async function generateImage(opts: {
  prompt: string;
  fileKey: string;
  width?: number;
  height?: number;
  nodeId?: string;
  model?: string;
}): Promise<GeneratedImage> {
  // 1. Generate and place the image in the target file.
  const genSchema = await figma.toolSchema("generate_image");
  if (!genSchema) {
    throw new Error(
      "The Figma MCP server does not expose generate_image. Check that your plan includes Figma AI.",
    );
  }
  // model is only sent when the tool schema actually declares it; a schema
  // enum (if present) is surfaced via GET /debug/tools.
  const genArgs = filterBySchema(genSchema, {
    prompt: opts.prompt,
    fileKey: opts.fileKey,
    nodeId: opts.nodeId,
    width: opts.width,
    height: opts.height,
    model: opts.model,
  });
  let genResult: ToolResult;
  for (let attempt = 1; ; attempt++) {
    try {
      genResult = await figma.callTool("generate_image", genArgs);
      break;
    } catch (err) {
      const enrich = () => {
        if (err instanceof FigmaMcpError) {
          // Re-throw with the exact args sent (prompt truncated) — makes bad
          // fileKey/model/size errors self-explanatory.
          return new FigmaMcpError(
            `${err.message} [sent: fileKey=${opts.fileKey}, model=${opts.model ?? "(figma default)"}, ` +
              `width=${opts.width ?? "auto"}, height=${opts.height ?? "auto"}, nodeId=${opts.nodeId ?? "none"}]`,
            err.status,
          );
        }
        return err;
      };
      // Figma's generation service fails transiently ("Image generation
      // failed"). Retry those; argument/schema errors are deterministic —
      // fail fast instead of burning attempts.
      const retryable =
        err instanceof FigmaMcpError &&
        !/invalid|validation|schema|required|expected|unsupported/i.test(err.message);
      if (!retryable || attempt >= 3) throw enrich();
      const delay = attempt * 3000;
      console.warn(
        `[figma] generate_image attempt ${attempt} failed (${err instanceof Error ? err.message.split("\n")[0] : err}); retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  const gen = parseToolJson(genResult);
  const model = pick(gen, ["model", "modelId", "model_id"]);
  const nodeId = pick(gen, ["nodeId", "node_id", "id"]);
  const fileKey = pick(gen, ["fileKey", "file_key"]) ?? opts.fileKey;
  if (config.debug) {
    console.log(`[debug] generate_image text: ${resultText(genResult).slice(0, 800)}`);
  }

  // Only clean up when the download actually succeeded — the node is the
  // user's paid output; never destroy it because a download failed.
  let result: GeneratedImage | undefined;
  result = await pickBestImage(genResult, gen, { prompt: opts.prompt, model, fileKey, nodeId });
  // Last resort only: the inline image block is a low-res thumbnail preview.
  if (!result) {
    const inline = (genResult.content ?? []).find((c) => c.type === "image" && c.data);
    if (inline?.data) {
      result = {
        prompt: opts.prompt,
        model,
        fileKey,
        nodeId,
        bytes: Buffer.from(inline.data, "base64"),
        contentType: inline.mimeType ?? "image/png",
      };
    }
  }
  if (!result) {
    throw new Error(
      "Figma generated the image but returned no usable asset URL. The generated node was " +
        "kept in the file — grab it manually from " +
        (nodeId ? `node ${nodeId}` : "the canvas") +
        " in file " +
        fileKey,
    );
  }
  await cleanupNode(fileKey, nodeId, opts.nodeId);
  return result;
}

/**
 * Downloads candidate URLs in priority order and keeps the highest-resolution
 * result. generate_image's image.url is the full-resolution original; the
 * first URL in the text and the download_assets render are fallbacks.
 */
async function pickBestImage(
  genResult: ToolResult,
  gen: Record<string, unknown>,
  meta: { prompt: string; model?: string; fileKey: string; nodeId?: string },
): Promise<GeneratedImage | undefined> {
  const reported = reportedDimensions(gen);
  const candidates: string[] = [];
  for (const url of [extractImageUrl(gen), extractFirstUrl(genResult)]) {
    if (url && !candidates.includes(url)) candidates.push(url);
  }
  const assetsUrl = await downloadViaAssets(meta.fileKey, meta.nodeId);
  if (assetsUrl && !candidates.includes(assetsUrl)) candidates.push(assetsUrl);
  if (candidates.length === 0) return undefined;

  let best: { image: GeneratedImage; pixels: number } | undefined;
  for (const url of candidates) {
    const image = await finishImage(url, meta.prompt, meta.model, meta.fileKey, meta.nodeId);
    const dims = imageDimensions(image.bytes);
    const kb = Math.round(image.bytes.length / 1024);
    if (dims) {
      console.log(`[figma] downloaded ${dims.width}x${dims.height} (${kb} KB) from ${new URL(url).host}`);
      // Native resolution or better — accept immediately.
      if (!reported || (dims.width >= reported.width && dims.height >= reported.height)) {
        return image;
      }
      console.warn(`[figma] Downloaded image is smaller than expected ${reported.width}x${reported.height}, trying next source`);
    } else {
      console.log(`[figma] downloaded ${kb} KB (unrecognized dimensions) from ${new URL(url).host}`);
    }
    const pixels = dims ? dims.width * dims.height : image.bytes.length;
    if (!best || pixels > best.pixels) best = { image, pixels };
  }
  return best?.image;
}

/** Reads pixel dimensions straight from PNG/JPEG bytes. */
function imageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  // PNG: IHDR width/height at fixed offsets
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: scan for the SOF0-SOF15 marker (minus DHT/JPG/DAC)
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = bytes[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(off + 5), width: bytes.readUInt16BE(off + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        off += 2;
        continue;
      }
      off += 2 + bytes.readUInt16BE(off + 2);
    }
  }
  return undefined;
}

/** The pixel size Figma says the generated image has. */
function reportedDimensions(gen: Record<string, unknown>): { width: number; height: number } | undefined {
  const image = gen.image as Record<string, unknown> | undefined;
  for (const src of [gen, image ?? {}]) {
    const width = src.width;
    const height = src.height;
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return undefined;
}

async function downloadViaAssets(fileKey: string, nodeId?: string): Promise<string | undefined> {
  if (!nodeId) return undefined;
  const dlSchema = await figma.toolSchema("download_assets");
  if (!dlSchema) return undefined;
  const dlArgs = filterBySchema(dlSchema, buildDownloadArgs(dlSchema, fileKey, nodeId));
  const dlResult = await figma.callTool("download_assets", dlArgs);
  return extractFirstUrl(dlResult);
}

/** Deletes the generated image node via the use_figma Plugin-API tool. */
async function cleanupNode(fileKey: string, nodeId?: string, requestedNodeId?: string): Promise<void> {
  if (config.keepImages) return;
  // Only delete frames this call created — never a node the caller targeted
  // for fill replacement, and nothing if we somehow lost track of the id.
  if (!nodeId || requestedNodeId) return;
  try {
    const schema = await figma.toolSchema("use_figma");
    if (!schema) return;
    const code = `const n = figma.getNodeById(${JSON.stringify(nodeId)}); if (n) n.remove();`;
    await figma.callTool(
      "use_figma",
      filterBySchema(schema, {
        fileKey,
        code,
        description: "Delete the temporary generated image node after it was downloaded",
      }),
    );
    console.log(`[figma] Cleaned up generated node ${nodeId} from file ${fileKey}`);
  } catch (err) {
    console.warn(
      `[figma] Could not delete generated node ${nodeId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function finishImage(
  url: string,
  prompt: string,
  model: string | undefined,
  fileKey: string,
  nodeId?: string,
): Promise<GeneratedImage> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image from Figma (HTTP ${response.status})`);
  }
  return {
    prompt,
    model,
    fileKey,
    nodeId,
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "image/png",
  };
}

function buildDownloadArgs(
  schema: Tool | JsonSchema | undefined,
  fileKey: string,
  nodeId?: string,
): Record<string, unknown> {
  const listProp = arrayProperty(schema);
  if (listProp && nodeId) {
    return filterBySchema(schema, {
      fileKey,
      [listProp]: [nodeId],
      defaultFormat: "png",
      defaultScale: 4,
    });
  }
  return filterBySchema(schema, {
    fileKey,
    nodeId,
    nodeIds: nodeId ? [nodeId] : undefined,
    defaultFormat: "png",
    defaultScale: 4,
  });
}
