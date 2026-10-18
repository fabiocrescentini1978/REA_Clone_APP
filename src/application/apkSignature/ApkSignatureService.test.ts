import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { ApkSignatureProvider } from "../../apkSignature/ApkSignatureProvider.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { ok } from "../../domain/result.js";
import { ApkSignatureService } from "./ApkSignatureService.js";

it("retains completed APK Evidence and the abort reason on late cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-apk-service-"));
  const provider = new ApkSignatureProvider();
  try {
    const path = join(root, "unsigned.apk");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("classes.dex", new TextReader("x"));
    await writeFile(path, await writer.close());
    const completed = await provider.inspect({ path });
    if (!completed.ok) throw completed.error;

    const controller = new AbortController();
    const reason = new Error("late abort reason");
    const result = await new ApkSignatureService({
      close: () => Promise.resolve(),
      inspect: () => {
        controller.abort(reason);
        return Promise.resolve(ok(completed.value));
      },
    }).inspect({ path }, { signal: controller.signal });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toMatchObject({
      operation: "inspect_apk_signature",
      normalized_result: completed.value.result,
    });
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
