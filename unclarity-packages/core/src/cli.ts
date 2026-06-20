#!/usr/bin/env node
import { run, type RunRequest } from "./run.js";
import { runCanary, canaryExitCode } from "./canary.js";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// Minimal flag parser: --flag value, --flag=value, and the -o alias for --out. A value is only
// consumed if the next token isn't itself a flag (so a missing value stays "" rather than swallowing
// the next flag).
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (key: string, i: number): number => {
    const nextIsValue = i + 1 < argv.length && !argv[i + 1]!.startsWith("-");
    out[key] = nextIsValue ? argv[i + 1]! : "";
    return nextIsValue ? i + 1 : i;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else i = take(a.slice(2), i);
    } else if (a === "-o") {
      i = take("out", i);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "run") {
    // RunRequest JSON on stdin; SessionResult JSON lines on stdout (the Python client contract).
    const req = JSON.parse(await readStdin()) as RunRequest;
    let failed = 0;
    for await (const result of run(req)) {
      emit({ type: "result", ...result });
      if (result.verdict === "failed") failed++;
    }
    emit({ type: "done", failed });
    process.exit(failed > 0 ? 1 : 0);
  } else if (cmd === "capture") {
    const flags = parseFlags(process.argv.slice(3));
    const url = process.argv[3] && !process.argv[3].startsWith("-") ? process.argv[3] : flags.url;
    if (!url || !flags.out) {
      process.stderr.write("usage: unclarity capture <url> -o <dir> [--steps file.json] [--storage-state file]\n");
      process.exit(2);
    }
    const captureSpecifier = ["@unclarity", "capture"].join("/"); // dynamic so core has no hard dep
    const capture = (await import(captureSpecifier).catch(() => null)) as { capture?: (o: unknown) => Promise<unknown> } | null;
    if (!capture?.capture) {
      process.stderr.write("@unclarity/capture is not installed (Playwright). Install it to use capture.\n");
      process.exit(2);
    }
    const { readFileSync } = await import("node:fs");
    const steps = flags.steps ? JSON.parse(readFileSync(flags.steps, "utf8")) : undefined;
    const manifest = await capture.capture({
      url,
      outDir: flags.out,
      ...(steps ? { steps } : {}),
      ...(flags["storage-state"] ? { storageState: flags["storage-state"] } : {}),
      ...(flags.device ? { device: flags.device } : {}),
    });
    emit({ type: "captured", manifest });
  } else if (cmd === "canary") {
    const flags = parseFlags(process.argv.slice(3));
    if (!flags.project) {
      process.stderr.write("usage: unclarity canary --project <id> [--pinned <version>]\n");
      process.exit(2);
    }
    const result = await runCanary(flags.project, flags.pinned || undefined);
    emit(result);
    process.exit(canaryExitCode(result)); // 0 current, 10 newer-compatible, 1 drift
  } else {
    process.stderr.write("usage: unclarity <run|capture|canary>\n");
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`unclarity: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
