// Entry point of the parsing-sandbox Worker (see sandbox.ts). Runs MIME parse, HTML to text, PDF to text and
// redaction for ONE message, posts the (already redacted) result, and exits.
import { parentPort, workerData } from "node:worker_threads";
import { prepareEmailInProcess, type PrepareOptions, type PrepareResult } from "./prepare.js";

interface Job {
  raw: Uint8Array;
  options: PrepareOptions;
}

const job = workerData as Job;
const post = (r: PrepareResult) => parentPort?.postMessage(r);

prepareEmailInProcess(job.raw, job.options).then(post, () => post({ ok: false, reason: "malformed" }));
