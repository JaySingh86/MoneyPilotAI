// The public entry point: raw message bytes in, REDACTED text out, parsed in an isolated Worker.
//
// Email is hostile input and the parsers (postal-mime, html-to-text, pdfjs) are large. Each message is
// handled in its own `worker_threads` Worker with a V8 heap cap and a hard wall-clock timeout; on timeout,
// out-of-memory or crash the worker is terminated, the caller gets `{ ok: false, reason: "parse_limit" }`
// (or "malformed" for a plain crash), and the parent process is untouched (BACKEND_PLAN §7.8.2, Q-067).
// Before any worker is started, messages above the size cap or with more than 200 MIME parts are refused.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { countMimeParts, MAX_MIME_PARTS } from "./mime-parts.js";
import { EMAIL_LIMITS, type PrepareOptions, type PrepareResult } from "./prepare.js";

export interface SandboxOptions {
  /** Wall-clock budget for the whole message. Default 20 s. */
  timeoutMs?: number;
  /** V8 old-generation cap for the worker. Default 256 MB. */
  maxOldGenerationSizeMb?: number;
  /** Worker module to run. Tests use this to inject spin/OOM/crash workers. */
  entry?: URL;
}

export const SANDBOX_DEFAULTS = {
  timeoutMs: 20_000,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
} as const;

const DEFAULT_ENTRY = new URL("./worker-entry.ts", import.meta.url);

/** Extra node flags so a `.ts` worker entry loads when the parent is not itself running under tsx. */
function execArgvFor(entry: URL): string[] {
  const base = [...process.execArgv];
  if (!entry.pathname.endsWith(".ts")) return base;
  if (base.some((a) => a.includes("tsx"))) return base; // already inherited from `tsx src/index.ts`
  try {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    return [...base, "--import", tsx];
  } catch {
    return base; // plain Node with type stripping, or a build that ships .js
  }
}

export type PrepareEmailOptions = PrepareOptions & { sandbox?: SandboxOptions };

export async function prepareEmail(
  raw: string | Uint8Array,
  options: PrepareEmailOptions = {},
): Promise<PrepareResult> {
  const { sandbox, ...prepareOptions } = options;
  const maxRaw = prepareOptions.limits?.maxRawBytes ?? EMAIL_LIMITS.maxRawBytes;
  const source = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  if (source.length > maxRaw) return { ok: false, reason: "too_large" };
  if (countMimeParts(source) > MAX_MIME_PARTS) return { ok: false, reason: "parse_limit" };

  const entry = sandbox?.entry ?? DEFAULT_ENTRY;
  const timeoutMs = sandbox?.timeoutMs ?? SANDBOX_DEFAULTS.timeoutMs;
  const copy = new Uint8Array(source); // transferred to the worker, so the caller's buffer stays valid

  return new Promise<PrepareResult>((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    const finish = (r: PrepareResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "parse_limit" }), timeoutMs);

    try {
      worker = new Worker(fileURLToPath(entry), {
        workerData: { raw: copy, options: prepareOptions },
        transferList: [copy.buffer],
        execArgv: execArgvFor(entry),
        resourceLimits: {
          maxOldGenerationSizeMb: sandbox?.maxOldGenerationSizeMb ?? SANDBOX_DEFAULTS.maxOldGenerationSizeMb,
          maxYoungGenerationSizeMb: SANDBOX_DEFAULTS.maxYoungGenerationSizeMb,
          stackSizeMb: SANDBOX_DEFAULTS.stackSizeMb,
        },
        stdout: true, // keep parser noise out of the parent's stdout
        stderr: true,
      });
    } catch {
      finish({ ok: false, reason: "malformed" });
      return;
    }

    worker.on("message", (m: unknown) => {
      if (m && typeof m === "object" && "ok" in m) finish(m as PrepareResult);
    });
    worker.on("error", (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      finish({ ok: false, reason: code === "ERR_WORKER_OUT_OF_MEMORY" ? "parse_limit" : "malformed" });
    });
    worker.on("exit", () => finish({ ok: false, reason: "parse_limit" }));
  });
}
