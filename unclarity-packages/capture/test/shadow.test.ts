import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBundle } from "@unclarity/core";
import { capture } from "../src/index.js";

const SHADOW_HTML = `<!DOCTYPE html><html><head><title>shadow</title></head><body>
<div id="host"></div>
<script>
  const sr = document.getElementById("host").attachShadow({ mode: "open" });
  sr.innerHTML = '<button id="shadowbtn">Shadow Button</button>';
</script></body></html>`;

// Open shadow DOM must be captured, not silently dropped (S1). Gated: run with UNCLARITY_CAPTURE=1.
describe.runIf(process.env.UNCLARITY_CAPTURE === "1")("open shadow DOM capture", () => {
  it("inlines shadow content as declarative shadow DOM and measures shadow nodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uc-shadow-"));
    const htmlFile = join(dir, "page.html");
    writeFileSync(htmlFile, SHADOW_HTML);
    const out = join(dir, "bundle");
    await capture({ url: pathToFileURL(htmlFile).href, outDir: out, waitUntil: "domcontentloaded", steps: [{ action: "wait", ms: 300 }] });

    const bundle = await loadBundle(out);
    expect(bundle.html).toContain("shadowrootmode"); // declarative shadow DOM template present
    expect(bundle.html).toContain("Shadow Button"); // shadow content captured, not dropped
  }, 60000);
});
