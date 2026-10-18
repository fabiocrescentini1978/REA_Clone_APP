import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { JavaScriptDeobfuscationResult } from "../../domain/javascript/javascriptDeobfuscation.js";
import { err, ok } from "../../domain/result.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { JavaScriptDeobfuscationService } from "./JavaScriptDeobfuscationService.js";

const file = { path: "/tmp/source.js", sha256: "a".repeat(64), bytes: 12 };
const provider = {
  id: "fixture-deobfuscator",
  name: "Fixture deobfuscator",
  version: "1",
} as const;
const result = (outputRoot = "/tmp/out"): JavaScriptDeobfuscationResult => {
  const artifact = (relativePath: string) => ({
    path: join(outputRoot, relativePath),
    sha256: file.sha256,
    bytes: file.bytes,
  });
  return {
    source: { ...file, published_copy: artifact("inputs/source.js") },
    options: { max_iterations: 16 },
    status: "unchanged",
    output: artifact("deobfuscated/source.js"),
    report: artifact("reports/js-redox.json"),
    manifest: artifact("manifest.json"),
    proof: {
      input_sha256: file.sha256,
      output_sha256: file.sha256,
    },
    analysis_input: {
      input_path: join(outputRoot, "deobfuscated"),
      format: "directory",
    },
    runtime_execution: "not-performed",
    limitations: [],
  };
};

it.each(["changed", "unchanged"] as const)(
  "rejects %s status that contradicts source/output digests",
  async (status) => {
    const returned = result();
    returned.status = status;
    if (status === "unchanged") {
      returned.output = { ...returned.output, sha256: "b".repeat(64) };
    }
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () =>
        ok(
          createAnalysisExecution(returned, provider, {
            subject: {
              path: file.path,
              sha256: file.sha256,
              format: "javascript",
            },
          }),
        ),
    });
    const response = await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
    });
    if (response.ok) throw new Error("expected status binding rejection");
    expect(response.error._tag).toBe("AnalysisOutputError");
  },
);
it.each([64, 15])(
  "rejects provider options=%s for a requested bound of one",
  async (maximum) => {
    const returned = result();
    returned.options.max_iterations = maximum;
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () =>
        ok(
          createAnalysisExecution(returned, provider, {
            subject: {
              path: file.path,
              sha256: file.sha256,
              format: "javascript",
            },
          }),
        ),
    });
    const response = await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
      max_iterations: 1,
    });
    if (response.ok) throw new Error("expected iteration binding rejection");
    expect(response.error._tag).toBe("AnalysisOutputError");
  },
);
it.each([
  { ...file, sha256: "b".repeat(64) },
  { ...file, bytes: file.bytes + 1 },
])("rejects a published source copy with mismatched metadata", async (copy) => {
  const returned = result();
  returned.source.published_copy = copy;
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected published source mismatch");
  expect(response.error._tag).toBe("AnalysisOutputError");
});
it("preserves provider failures", async () => {
  const failure = new AnalysisCapabilityUnavailableError(
    "js-redox",
    "deobfuscate_javascript_source",
    "fixture unavailable",
  );
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => err(failure),
  });
  expect(
    await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
    }),
  ).toEqual(err(failure));
});

it("accepts canonical provider paths beneath a symlinked output parent", async () => {
  const root = await createTestTempDirectory("rea-js-service-output-link-");
  const canonicalParent = join(root, "canonical");
  const aliasParent = join(root, "alias");
  await mkdir(canonicalParent);
  await symlink(canonicalParent, aliasParent);
  const selectedOutput = join(aliasParent, "out");
  const canonicalOutput = join(await realpath(aliasParent), "out");
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(result(canonicalOutput), provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: selectedOutput,
  });
  if (!response.ok) throw response.error;
  expect(response.value.subject?.format).toBe("javascript");
});

it("binds symlink-dotdot output semantics before provider execution", async () => {
  const root = await createTestTempDirectory("rea-js-service-output-dotdot-");
  const canonicalParent = join(root, "canonical");
  const child = join(canonicalParent, "child");
  const alias = join(root, "alias");
  await mkdir(child, { recursive: true });
  await symlink(child, alias);
  const selectedOutput = `${alias}/../out`;
  const canonicalOutput = join(canonicalParent, "out");
  let providerOutput: string | undefined;
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async (request) => {
      expect(Object.isFrozen(request)).toBe(true);
      providerOutput = request.output_directory;
      return ok(
        createAnalysisExecution(result(canonicalOutput), provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: selectedOutput,
  });
  if (!response.ok) throw response.error;
  expect(providerOutput).toBe(canonicalOutput);
  expect(response.value.parameters).toMatchObject({
    output_directory: selectedOutput,
  });
});

it("carries normalized result limitations into Evidence", async () => {
  const returned = result();
  returned.limitations = ["provider-normalized caveat"];
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (!response.ok) throw response.error;
  expect(response.value.limitations).toContain("provider-normalized caveat");
});

it("accepts a schema-valid result bound to JavaScript Evidence", async () => {
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(result(), provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (!response.ok) throw new Error("expected valid deobfuscation Evidence");
  if (response.value.subject === null)
    throw new Error("expected deobfuscation Evidence subject");
  expect(response.value.subject.format).toBe("javascript");
});

it.each([
  "invalid-result",
  "missing-subject",
  "subject-mismatch",
  "subject-format-mismatch",
  "proof-output-mismatch",
])("rejects %s returned across the provider boundary", async (mode) => {
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(
          mode === "invalid-result"
            ? {}
            : mode === "proof-output-mismatch"
              ? {
                  ...result(),
                  proof: {
                    ...result().proof,
                    output_sha256: "b".repeat(64),
                  },
                }
              : result(),
          provider,
          mode === "missing-subject"
            ? {}
            : {
                subject: {
                  path: mode === "subject-mismatch" ? "/wrong.js" : file.path,
                  sha256: file.sha256,
                  format:
                    mode === "subject-format-mismatch"
                      ? ("pe" as const)
                      : ("javascript" as const),
                },
              },
        ),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected invalid provider output");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it.each([
  "source-copy",
  "output",
  "report",
  "manifest",
  "analysis-input",
] as const)("rejects a relative returned %s path", async (field) => {
  const returned = result();
  switch (field) {
    case "source-copy":
      returned.source.published_copy.path = "out/inputs/source.js";
      break;
    case "output":
      returned.output.path = "out/deobfuscated/source.js";
      break;
    case "report":
      returned.report.path = "out/reports/js-redox.json";
      break;
    case "manifest":
      returned.manifest.path = "out/manifest.json";
      break;
    case "analysis-input":
      returned.analysis_input.input_path = "out/deobfuscated";
      break;
  }
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected relative provider path rejection");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it("rejects an analysis handoff that does not name the transformed file directory", async () => {
  const returned = result();
  returned.analysis_input.input_path = "/tmp/out/inputs";
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected analysis handoff rejection");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it.each(["path", "output_directory"])(
  "rejects relative %s before invoking the provider",
  async (field) => {
    let invoked = false;
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () => {
        invoked = true;
        return ok(createAnalysisExecution(result(), provider));
      },
    });
    const response = await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
      [field]: "relative.js",
    });
    expect(invoked).toBe(false);
    if (response.ok) throw new Error("expected invalid path");
    expect(response.error._tag).toBe("AnalysisInputError");
  },
);
