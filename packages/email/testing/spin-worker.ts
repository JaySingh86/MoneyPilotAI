// Sandbox test entry: never answers and never yields (a CPU-spin DoS). The parent must kill it.
import { parentPort } from "node:worker_threads";

parentPort?.postMessage("started");
for (;;) {
  // busy loop
}
