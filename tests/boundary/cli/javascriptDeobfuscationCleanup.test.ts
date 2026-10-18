import { Cli } from "incur";
import { expect, it } from "vitest";

import { registerJavaScriptDeobfuscationCommands } from "../../../src/cli/javascriptDeobfuscationCommands.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";

it("retains completed deobfuscation Evidence when final close fails", async () => {
  const evidence = createEvidence(
    { path: "/tmp/input.js", sha256: "a".repeat(64), format: "javascript" },
    { id: "js-redox", name: "Fixture js-redox", version: "0.1.0" },
    {
      operation: "deobfuscate_javascript_source",
      parameters: {},
      result: { status: "unchanged" },
      confidence: "derived",
    },
  );
  const cli = Cli.create("javascript-deobfuscation-cleanup-test", {
    sync: false,
  });
  registerJavaScriptDeobfuscationCommands(
    cli,
    silentLogger,
    {},
    {
      deobfuscate: async () => ok(evidence),
      close: async () => {
        throw new ProviderCleanupError(
          "js-redox",
          ["js-redox artifact handles"],
          { reason: "cleanup retry failed" },
          { operation: "deobfuscate_javascript_source" },
        );
      },
    },
  );

  let stdout = "";
  await cli.serve(
    [
      "deobfuscate-javascript-source",
      "/tmp/input.js",
      "/tmp/output",
      "--format",
      "json",
    ],
    {
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    },
  );

  expect(JSON.parse(stdout)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      resources: ["js-redox artifact handles"],
      partial_observation: { evidence_id: evidence.evidence_id },
    },
  });
});
