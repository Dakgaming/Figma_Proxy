import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import { config, parseFileKey } from "../config.js";
import { figma, FigmaMcpError } from "../figma/client.js";
import { generateImage, imageDimensions, type GeneratedImage } from "../figma/pipeline.js";
import { fitToSize, type OutputFormat } from "../image/transform.js";

const fileStore = new Map<string, { bytes: Buffer; contentType: string }>();

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
  ) {
    super(message);
  }
}

function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

function requireProxyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.proxyApiKey) return next();
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${config.proxyApiKey}`) return next();
  res.status(401).json({
    error: { message: "Invalid or missing API key", type: "invalid_request_error", code: "invalid_api_key" },
  });
}

function parseSize(size: unknown): { width?: number; height?: number } {
  if (typeof size !== "string") return {};
  const trimmed = size.trim();
  if (!trimmed || trimmed === "auto") return {};
  const match = trimmed.match(/^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/);
  if (!match) return {};
  // Output ceiling: anything above this is a mistake, not a wallpaper.
  const width = Math.min(Number(match[1]), 4096);
  const height = Math.min(Number(match[2]), 4096);
  return width > 0 && height > 0 ? { width, height } : {};
}

/**
 * generate_image caps width/height at 2048 and only uses the pair to pick the
 * closest supported aspect ratio, so the hint is scaled down proportionally —
 * clamping one axis alone would corrupt the aspect.
 */
function figmaSizeHint(target: { width?: number; height?: number }): { width?: number; height?: number } {
  const { width, height } = target;
  if (!width || !height) return {};
  const longest = Math.max(width, height);
  if (longest <= 2048) return { width, height };
  const factor = 2048 / longest;
  return { width: Math.round(width * factor), height: Math.round(height * factor) };
}

function parseOutputFormat(value: unknown): OutputFormat | undefined {
  if (typeof value !== "string") return undefined;
  const format = value.trim().toLowerCase();
  return format === "png" || format === "jpeg" || format === "jpg" || format === "webp"
    ? (format === "jpg" ? "jpeg" : format)
    : undefined;
}

/** Applies the caller's requested size/format to the downloaded bytes. */
async function applyOutput(
  image: GeneratedImage,
  target: { width?: number; height?: number },
  opts: { format?: OutputFormat; quality?: number },
): Promise<{ bytes: Buffer; contentType: string }> {
  const same: { bytes: Buffer; contentType: string } = { bytes: image.bytes, contentType: image.contentType };
  const wantedType = opts.format === "jpeg" ? "image/jpeg" : opts.format === "webp" ? "image/webp" : "image/png";
  const formatMatches = !opts.format || image.contentType.startsWith(wantedType);
  if (!target.width || !target.height) {
    return formatMatches ? same : fitToSize(image.bytes, imageDimensions(image.bytes) ?? { width: 0, height: 0 }, opts);
  }
  const wanted = { width: target.width, height: target.height };
  const current = imageDimensions(image.bytes) ?? { width: 0, height: 0 };
  if (current.width === wanted.width && current.height === wanted.height) {
    return formatMatches ? same : fitToSize(image.bytes, wanted, opts);
  }
  // Figma's native output is smaller than what callers usually ask for;
  // upscaling is opt-out because "give me 1920x1080" means exactly that.
  const shrinking = current.width > wanted.width || current.height > wanted.height;
  if (!config.upscale && !shrinking) return same;
  return fitToSize(image.bytes, wanted, opts);
}

function absoluteUrl(req: Request, path: string): string {
  const host = req.get("host") ?? `localhost:${config.port}`;
  return `${req.protocol}://${host}${path}`;
}

export const router = Router();

router.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

router.get("/auth/status", (_req, res) => {
  res.json({
    authenticated: figma.authenticated,
    connected: figma.hasConnectedClient(),
    mcp_url: config.mcpUrl,
    token_store: config.tokenStorePath,
  });
});

// Triggers the OAuth browser flow if needed; blocks until authorization completes.
router.get("/auth/login", asyncHandler(async (_req, res) => {
  await figma.ensureConnected();
  res.json({ status: "connected" });
}));

// Known-good fallback; the live list comes from generate_image's schema enum.
const FALLBACK_FIGMA_MODELS = [
  "gemini-3.1-flash-lite-image",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gemini-3.1-flash-image",
];

async function figmaModels(): Promise<string[]> {
  try {
    const schema = await figma.toolSchema("generate_image");
    const model = (schema as { inputSchema?: { properties?: Record<string, { enum?: unknown[] }> } } | undefined)
      ?.inputSchema?.properties?.model;
    const list = Array.isArray(model?.enum) ? model!.enum!.filter((m): m is string => typeof m === "string") : [];
    if (list.length > 0) return list;
  } catch {
    // fall through
  }
  return FALLBACK_FIGMA_MODELS;
}

router.get("/v1/models", requireProxyAuth, asyncHandler(async (_req, res) => {
  const models = await figmaModels();
  res.json({
    object: "list",
    data: [
      // alias meaning "use the configured/default model"
      {
        id: config.modelId,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "figma",
      },
      ...models.map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "figma",
      })),
    ],
  });
}));

// Dumps the resolved configuration (no secrets) for diagnosing requests.
router.get("/debug/config", requireProxyAuth, (_req, res) => {
  res.json({
    defaultFileKey: config.defaultFileKey || null,
    defaultFileKeyLength: config.defaultFileKey.length,
    figmaModel: config.figmaModel || null,
    modelId: config.modelId,
    mcpUrl: config.mcpUrl,
    upscale: config.upscale,
    outputFormat: config.outputFormat,
    defaultSize: config.defaultSize ?? null,
  });
});

// Dumps the MCP tool catalog with input schemas — used to discover things like
// the model ids generate_image accepts (see README, "Choosing a Figma model").
router.get("/debug/tools", requireProxyAuth, asyncHandler(async (_req, res) => {
  const tools = await figma.listTools();
  res.json(tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })));
}));

router.post(
  "/v1/images/generations",
  requireProxyAuth,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw badRequest("prompt is required");
    if (body.input && !prompt) throw badRequest("prompt is required");

    const n = Math.min(Math.max(Number(body.n ?? 1) || 1, 1), 10);
    const fileKey =
      parseFileKey(body.fileKey ?? body.file ?? body.figma_file) || config.defaultFileKey;
    if (!fileKey) {
      throw badRequest(
        'No target Figma file. Set FIGMA_FILE_KEY in .env, or pass "fileKey" (raw key or URL) in the request body.',
      );
    }
    const target = parseSize(body.size);
    if (!target.width && !target.height && config.defaultSize) {
      Object.assign(target, config.defaultSize);
    }
    const hint = figmaSizeHint(target);
    const outputFormat = parseOutputFormat(body.output_format) ?? config.outputFormat;
    const compression = Number(body.output_compression);
    const outputOpts = {
      format: outputFormat,
      quality: Number.isFinite(compression) && compression > 0 ? Math.min(Math.round(compression), 100) : undefined,
    };
    const wantUrl = body.response_format === "url";
    const nodeId = typeof body.nodeId === "string" && body.nodeId ? body.nodeId : undefined;
    // Figma's tool schema requires 22-128 alphanumeric chars; fail with a clear
    // message instead of the server's cryptic -32602.
    if (!/^[0-9a-zA-Z]{22,128}$/.test(fileKey)) {
      throw badRequest(
        `fileKey "${fileKey}" (${fileKey.length} chars) does not match Figma's required format ` +
          "of 22-128 alphanumeric characters. Check FIGMA_FILE_KEY in .env — copy the file URL " +
          "directly from the Figma address bar, or inspect GET /debug/config to see what was parsed.",
      );
    }
    // Pass a model through to Figma when the caller names one explicitly;
    // otherwise use the configured default (FIGMA_MODEL) or let Figma pick.
    const requestedModel =
      typeof body.model === "string" && body.model && body.model !== config.modelId
        ? body.model
        : config.figmaModel || undefined;

    const data: Array<Record<string, unknown>> = [];
    let figmaModel: string | undefined;
    for (let i = 0; i < n; i++) {
      const image = await generateImage({
        prompt,
        fileKey,
        width: hint.width,
        height: hint.height,
        nodeId,
        model: requestedModel,
      });
      figmaModel ??= image.model;
      const out = await applyOutput(image, target, outputOpts);
      if (wantUrl) {
        const id = randomUUID().replaceAll("-", "");
        fileStore.set(id, { bytes: out.bytes, contentType: out.contentType });
        data.push({ url: absoluteUrl(req, `/files/${id}.${outputFormat}`), revised_prompt: prompt });
      } else {
        data.push({ b64_json: out.bytes.toString("base64"), revised_prompt: prompt });
      }
    }

    res.json({
      created: Math.floor(Date.now() / 1000),
      model: (typeof body.model === "string" && body.model) || figmaModel || config.modelId,
      data,
      // Not part of the OpenAI schema; useful for tracing where the image landed.
      figma: { fileKey, model: figmaModel },
    });
  }),
);

router.get("/files/:id", requireProxyAuth, (req, res) => {
  const id = (req.params.id ?? "").replace(/\.(png|jpe?g|webp)$/i, "");
  const file = fileStore.get(id);
  if (!file) {
    res.status(404).json({
      error: { message: "File not found or expired (proxy restart clears served files)", type: "invalid_request_error" },
    });
    return;
  }
  res.setHeader("content-type", file.contentType);
  res.setHeader("cache-control", "private, max-age=86400");
  res.send(file.bytes);
});

export function openaiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = err instanceof HttpError ? err.status : err instanceof FigmaMcpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Internal server error";
  const type = err instanceof HttpError ? err.type : err instanceof FigmaMcpError ? "api_error" : "api_error";
  if (status >= 500) console.error("[proxy]", err);
  res.status(status).json({ error: { message, type } });
}
