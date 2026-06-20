import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/index.js";
import { scenario } from "../src/index.js";

const schema = (name: string): Record<string, unknown> => {
  const p = fileURLToPath(new URL(`../../../schemas/${name}`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf8"));
};

// schemas/ is the cross-language contract. These guard against the TS code drifting from it (the
// Python client is guarded by the mirror test in python/tests).
describe("schema parity (TS ↔ schemas/)", () => {
  it("device presets match run-request.json profile enum", () => {
    const s = schema("run-request.schema.json") as { properties: { profile: { enum: string[] } } };
    expect([...s.properties.profile.enum].sort()).toEqual(Object.keys(PRESETS).sort());
  });

  it("scenario step types match scenario.json", () => {
    const s = schema("scenario.schema.json") as { properties: { steps: { items: { oneOf: Array<{ properties: { type: { const: string } } }> } } } };
    const schemaTypes = s.properties.steps.items.oneOf.map((o) => o.properties.type.const).sort();
    // exercise every builder method so the produced step `type`s can be compared to the schema
    const built = scenario().wait(1).move("#a").click("#a").scrollTo(0).type("#a", "x").build();
    const builtTypes = [...new Set(built.steps.map((st) => st.type))].sort();
    expect(builtTypes).toEqual(schemaTypes);
  });
});
