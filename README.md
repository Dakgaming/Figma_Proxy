# Figma OpenAI Proxy

An OpenAI-compatible image generation API backed by your Figma account. It connects
to Figma's remote MCP server (`https://mcp.figma.com/mcp`), uses the `generate_image`
tool to create images with Figma's image models, and exposes the result through the
standard OpenAI generation endpoint — so anything that speaks the OpenAI Images API
can use your Figma account's AI.

```
OpenAI client ──POST /v1/images/generations──▶  this proxy  ──MCP (OAuth)──▶  mcp.figma.com
                                               │ generate_image      (Figma AI credits)
                                               │ download_assets
                                               ◀── PNG bytes ──▶ b64_json / hosted url
```

## How it works

1. On startup the proxy connects to Figma's remote MCP server. On first run a browser
   opens for the OAuth consent flow (Figma's MCP server only supports OAuth — personal
   access tokens are not accepted). Tokens are persisted to `.figma-auth.json` and
   refreshed automatically afterwards.
2. `POST /v1/images/generations` calls the MCP tool `generate_image`, which places the
   image into one of your Figma files (this is how Figma's tool works — the file is the
   destination canvas). Each image consumes Figma AI credits from that file's plan.
3. The proxy then calls `download_assets` to fetch the placed image back out as a PNG
   and returns it in the OpenAI response shape.

## Setup

```powershell
npm install
copy .env.example .env   # then edit: set FIGMA_FILE_KEY at minimum
npm run dev
```

On first request (or first startup) a browser window opens for Figma login. Allow
access once; the token is stored locally.

### Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8741` | Port the proxy listens on |
| `CALLBACK_PORT` | `8742` | Local OAuth callback port (must be free during login) |
| `PROXY_API_KEY` | *(empty)* | If set, clients must send `Authorization: Bearer <key>` |
| `FIGMA_FILE_KEY` | *(required)* | Target Figma file (raw key or full URL) images are generated into |
| `FIGMA_MODEL` | *(Figma default)* | Model used when a request doesn't name one |
| `FIGMA_KEEP_IMAGES` | *(off)* | `1` keeps generated nodes on the canvas instead of deleting them |
| `FIGMA_UPSCALE` | `1` | `0` returns Figma's native pixels instead of resizing to the requested `size` |
| `FIGMA_DEFAULT_SIZE` | *(empty)* | Size applied when a request omits `size`, e.g. `1920x1080` |
| `FIGMA_OUTPUT_FORMAT` | `png` | `png`, `jpeg`, or `webp` (per-request `output_format` wins) |
| `FIGMA_MCP_URL` | `https://mcp.figma.com/mcp` | Figma MCP endpoint |
| `MODEL_ID` | `figma-image-1` | Model name advertised on `/v1/models` |
| `TOKEN_STORE` | `.figma-auth.json` | Where OAuth tokens are persisted |

## API

### `POST /v1/images/generations`

```bash
curl http://localhost:8741/v1/images/generations \
  -H "content-type: application/json" \
  -d '{
    "model": "figma-image-1",
    "prompt": "hero illustration of a mountain trail at sunrise",
    "n": 1,
    "size": "1536x1024",
    "response_format": "b64_json"
  }'
```

Standard OpenAI fields: `prompt`, `model`, `n` (1–10), `size` (`"WxH"` or `"auto"`, max
4096), `response_format` (`"b64_json"` default, or `"url"`). Also supported:
`output_format` (`"png"`/`"jpeg"`/`"webp"`) and `output_compression` (0–100, jpeg/webp).

`size` is delivered **exactly**. Figma's models cap their native output at 1536px on
the long edge (1024px square) — verified: asking for 1920x1080 or 2048x1152 always comes
back 1536x864 — so larger sizes are resampled by the proxy (Lanczos3 + light unsharp
mask on upscale). Native detail can't be invented, but you get true 1920x1080 files.
Set `FIGMA_UPSCALE=0` to get Figma's raw pixels instead of a resample.

### Choosing a Figma model

`model` maps straight through to Figma's `generate_image` tool. Available ids (live
list also at `GET /v1/models`):

| Figma model id | Notes |
| --- | --- |
| `gpt-image-2.5-flare` | Figma's default |
| `gpt-image-2.5-sunburst` | |
| `gemini-3.1-flash-image` | |
| `gemini-3.1-flash-lite-image` | |

Set `FIGMA_MODEL` in `.env` to make one of them the default for every request; or
send `model` per request. Omitting both uses Figma's own default. Per-call credit
costs differ by model (check the Figma UI).

Non-standard extras (allowed since you control the caller):

- `fileKey` — override the target Figma file for this request (raw key or URL)
- `nodeId` — replace an existing image fill instead of creating a new frame

Response (OpenAI shape, plus a `figma` trace block):

```json
{
  "created": 1794290094,
  "model": "figma-image-1",
  "data": [{ "b64_json": "iVBORw0KGgo...", "revised_prompt": "..." }],
  "figma": { "fileKey": "AbCdEf123456", "model": "..." }
}
```

With `"response_format": "url"` the proxy serves the bytes itself at
`GET /files/<id>.png` (Figma's own asset URLs are temporary). Served files live in
memory and are lost on restart.

### Quality and canvas cleanup

The proxy downloads the **full-resolution** image from the URL `generate_image`
returns (`image.url`), not the inline thumbnail, and verifies the pixel dimensions
against what Figma reported.

Native ceiling per aspect (measured against the live MCP server):

| `size` requested | Figma returns |
| --- | --- |
| `1920x1080`, `2048x1152` | `1536x864` |
| `1024x1024` | `1024x1024` |

So `"size": "1920x1080"` gives a real 1920x1080 file, upscaled from 1536x864 in the
proxy (Lanczos3 + mild sharpen). `size` never distorts: near-identical aspect ratios
are resampled directly, genuinely different ones are centre-cropped to cover.

By default the generated node is **deleted from the Figma file** right after the
full-res image is downloaded (via the `use_figma` tool), so the file stays
clutter-free. Set `FIGMA_KEEP_IMAGES=1` in `.env` to keep them. Nodes you target
yourself via `nodeId` (fill replacement) are never deleted.

### `GET /v1/models`

Lists the advertised model.

### Auth / diagnostics

- `GET /auth/status` — OAuth state
- `GET /auth/login` — runs the browser login flow if needed
- `GET /healthz`

## Using it from anywhere

Any OpenAI SDK client works — point it at the proxy:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8741/v1",
  apiKey: "unused", // or your PROXY_API_KEY
});

const res = await client.images.generate({
  model: "figma-image-1",
  prompt: "isometric illustration of a shield logo, flat colors",
});
```

To expose it beyond localhost, put it behind a reverse proxy with HTTPS and set
`PROXY_API_KEY` — the OAuth token store gives full access to your Figma account.

## Notes

- Figma's remote MCP server accepts OAuth only; `X-Figma-Token` PATs are rejected by
  design, which is why the proxy runs the browser flow once and stores tokens.
- Figma additionally allowlists client names during OAuth registration: the consent
  page will show the client as "Claude Code" because that name is on the allowlist
  (self-hosted clients are otherwise rejected with 403 before login). If Figma
  tightens this, the login step may need updating.
- `generate_image` checks AI permissions and credits against the destination file, so
  the file must live on a plan with Figma AI enabled, and your account needs edit access.
- Requested `size` sets the aspect ratio Figma generates at; the proxy then delivers
  exactly that pixel size, resampling from Figma's native output (max 1536px long edge).
- The proxy advertises one model id. Figma picks the concrete image model per
  generation and returns it in the `figma.model` trace field.
