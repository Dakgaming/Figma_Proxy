import express from "express";
import { config } from "./config.js";
import { figma } from "./figma/client.js";
import { openaiErrorHandler, router } from "./openai/routes.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(router);
app.use(openaiErrorHandler);

app.listen(config.port, () => {
  console.log(`Figma OpenAI proxy listening on http://localhost:${config.port}`);
  console.log(`  Models:        GET  /v1/models`);
  console.log(`  Generate:      POST /v1/images/generations`);
  console.log(`  Auth status:   GET  /auth/status`);
  console.log(`  Login:         GET  /auth/login`);
  console.log(`  Health:        GET  /healthz`);
  if (config.defaultFileKey) {
    console.log(`Target file key: ${config.defaultFileKey} (${config.defaultFileKey.length} chars)`);
  } else {
    console.log(`\nNo FIGMA_FILE_KEY configured — requests must include a "fileKey" field.`);
  }
  if (!config.proxyApiKey) {
    console.log(`\nPROXY_API_KEY is not set; the proxy accepts unauthenticated requests.`);
  }
  // Connect (and kick off the browser OAuth flow on first run) eagerly.
  figma.ensureConnected().catch((err) => {
    console.error(`\n[auth] Initial connection failed: ${err instanceof Error ? err.message : err}`);
    console.error(`[auth] Complete the browser authorization, or visit /auth/login to retry.`);
  });
});
