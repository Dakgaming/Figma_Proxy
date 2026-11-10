import sharp from "sharp";

export interface Dimensions {
  width: number;
  height: number;
}

export type OutputFormat = "png" | "jpeg" | "webp";

export interface OutputOptions {
  format?: OutputFormat;
  /** 0-100; used for jpeg/webp only. */
  quality?: number;
}

const CONTENT_TYPES: Record<OutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Resamples an image to exactly `target` pixels.
 *
 * Figma's image models cap their native output (1536px on the long edge for
 * 16:9, 1024px square), so a requested size like 1920x1080 is delivered by
 * upscaling. Lanczos3 keeps edges clean; a light unsharp mask puts back the
 * micro-contrast that any upscale loses.
 */
export async function fitToSize(
  bytes: Buffer,
  target: Dimensions,
  opts: OutputOptions = {},
): Promise<{ bytes: Buffer; contentType: string; resized: boolean }> {
  const pipeline = sharp(bytes, { failOn: "none" });
  const meta = await pipeline.metadata();
  const srcWidth = meta.width ?? 0;
  const srcHeight = meta.height ?? 0;
  const format = opts.format ?? "png";
  const sameSize = srcWidth === target.width && srcHeight === target.height;
  const sameFormat = (meta.format ?? "") === (format === "jpeg" ? "jpeg" : format);

  if (sameSize && sameFormat) {
    return { bytes, contentType: CONTENT_TYPES[format], resized: false };
  }

  const srcAspect = srcWidth > 0 && srcHeight > 0 ? srcWidth / srcHeight : 0;
  const targetAspect = target.width / target.height;
  // Aspect handling: near-equal ratios resize straight to the target (no crop);
  // a genuinely different ratio is cropped to cover, never stretched.
  const aspectDiff = srcAspect > 0 ? Math.abs(srcAspect - targetAspect) / targetAspect : 0;
  const resized = pipeline.resize({
    width: target.width,
    height: target.height,
    fit: aspectDiff < 0.02 ? "fill" : "cover",
    position: "centre",
    kernel: "lanczos3",
  });

  // Only sharpen when we are actually inventing pixels.
  const upscaleFactor = srcWidth > 0 ? target.width / srcWidth : 1;
  if (upscaleFactor > 1.05) {
    resized.sharpen({ sigma: 0.7, m1: 0.5, m2: 1.6 });
  }

  if (format === "jpeg") {
    resized.jpeg({ quality: opts.quality ?? 95, chromaSubsampling: "4:4:4", mozjpeg: true });
  } else if (format === "webp") {
    resized.webp({ quality: opts.quality ?? 95, effort: 5 });
  } else {
    resized.png({ compressionLevel: 9, adaptiveFiltering: true });
  }

  const out = await resized.toBuffer();
  console.log(
    `[image] resized ${srcWidth}x${srcHeight} -> ${target.width}x${target.height} ` +
      `(${format}, ${Math.round(bytes.length / 1024)} KB -> ${Math.round(out.length / 1024)} KB)`,
  );
  return { bytes: out, contentType: CONTENT_TYPES[format], resized: true };
}
