/* eslint-disable no-console -- this file is a command line tool; stdout and stderr are its interface */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt } from "../prompts";
import { ROUTES } from "../config";
import { createAnthropicClient, createSdkTransport } from "../sdk-transport";
import type { ModelResponse } from "../transport";
import { buildSeedCorpus } from "./corpus-builder";
import { parseCorpus } from "./corpus";
import { allGatesPass } from "./metrics";
import {
  buildOracleRecording,
  createRecordingTransport,
  createReplayTransport,
  recordingFileSchema,
} from "./recordings";
import type { RecordingFile } from "./recordings";
import { renderReport } from "./report";
import { runEval } from "./runner";

// `pnpm ai:eval`            offline: replays the recording in evals/recordings. No network, no key needed.
// `pnpm ai:eval -- --live`  calls the real API. Needs ANTHROPIC_API_KEY AND the explicit --live flag.
// Other flags: --record (live only: save responses as the new recording), --budget-usd N (default 5),
//              --corpus <path> (an external corpus, e.g. consented real emails kept outside the repo; live only),
//              --regen-corpus, --regen-oracle (rewrite the committed synthetic corpus / oracle recording).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS_FILE = join(ROOT, "evals", "corpus", "seed.v1.json");
const RECORDING_FILE = join(ROOT, "evals", "recordings", "extract.v1.json");
const REPORT_DIR = join(ROOT, "evals", "reports");

function flag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function valueOf(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.filter((a) => a !== "--");
  if (flag(args, "--regen-corpus")) {
    writeJson(CORPUS_FILE, buildSeedCorpus());
    console.log(`wrote ${CORPUS_FILE}`);
  }
  const corpusArg = valueOf(args, "--corpus");
  const corpusFile = corpusArg ?? CORPUS_FILE;
  const corpus = parseCorpus(JSON.parse(readFileSync(corpusFile, "utf8")));
  const corpusLabel = corpusArg ? "external corpus (outside the repo)" : "evals/corpus/seed.v1.json";
  if (flag(args, "--regen-oracle")) {
    writeJson(RECORDING_FILE, buildOracleRecording(corpus));
    console.log(`wrote ${RECORDING_FILE}`);
  }

  const live = flag(args, "--live");
  // Real, consented emails never go into a committed file: their recordings would hold provider names and quotes.
  if (flag(args, "--record") && !corpus.synthetic) {
    console.error(
      "--record is only allowed for a synthetic corpus. Consented real corpora stay outside the repo.",
    );
    return 2;
  }
  if (!live && !corpus.synthetic) {
    console.error(
      "A non-synthetic corpus can only be evaluated with --live (there is no committed recording for it).",
    );
    return 2;
  }
  const budgetUsd = Number(valueOf(args, "--budget-usd") ?? "5");
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    console.error("--budget-usd must be a positive number");
    return 2;
  }
  const budgetMicros = Math.round(budgetUsd * 1_000_000);
  const prompt = loadPrompt("extract", ROUTES.extract.promptVersion);

  let transport;
  let recordingKind: string | undefined;
  let recordingNote: string | undefined;
  const captured: Record<string, ModelResponse> = {};

  if (live) {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      console.error("--live needs ANTHROPIC_API_KEY in the environment. Nothing was called.");
      return 2;
    }
    console.log(
      `LIVE MODE: calling the real Anthropic API (${ROUTES.extract.model}, ${corpus.cases.length} cases, budget cap $${budgetUsd.toFixed(2)}).`,
    );
    const real = createSdkTransport(createAnthropicClient());
    transport = flag(args, "--record") ? createRecordingTransport(real, captured) : real;
  } else {
    if (flag(args, "--record")) {
      console.error("--record only works together with --live.");
      return 2;
    }
    const recording: RecordingFile = recordingFileSchema.parse(
      JSON.parse(readFileSync(RECORDING_FILE, "utf8")),
    );
    if (recording.promptSha256 !== prompt.sha256) {
      console.error(
        "The recording was made for a different prompt text. Re-record (--live --record) or --regen-oracle.",
      );
      return 2;
    }
    recordingKind = recording.kind;
    recordingNote = recording.note;
    console.log(`OFFLINE MODE: replaying ${recording.kind} recording. No API call is made.`);
    transport = createReplayTransport(recording);
  }

  const report = await runEval({
    corpus,
    transport,
    mode: live ? "live" : "recorded",
    budgetMicros,
    corpusPath: corpusLabel,
    recordingKind,
    recordingNote,
  });

  if (live && flag(args, "--record")) {
    const recording: RecordingFile = {
      version: 1,
      kind: "live",
      promptId: report.promptId,
      promptSha256: prompt.sha256,
      model: ROUTES.extract.model,
      note: "Real model output captured with --live --record.",
      responses: captured,
    };
    writeJson(RECORDING_FILE, recording);
    console.log(`wrote ${RECORDING_FILE}`);
  }

  const markdown = renderReport(report);
  mkdirSync(REPORT_DIR, { recursive: true });
  // Live reports are git-ignored (evals/reports/latest-live.*); only the offline report is committed.
  const name = live ? "latest-live" : "latest";
  writeFileSync(join(REPORT_DIR, `${name}.md`), markdown);
  writeJson(join(REPORT_DIR, `${name}.json`), report);
  console.log(markdown);
  return allGatesPass(report) ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
