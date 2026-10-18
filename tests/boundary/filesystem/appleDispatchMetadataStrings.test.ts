import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { inspectAppleDispatchMetadata } from "../../../src/native/AppleDispatchMetadata.js";
import { withArtifactResourceScope } from "../../fixtures/artifactInventory.js";
import { machoWithPropertyAttributes } from "../../fixtures/objcPropertyMacho.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["plain names", "Fixture", "first", "perform:", false],
  ["leading U+FEFF", "\ufeffFixture", "\ufefffirst", "\ufeffperform:", false],
  ["U+FEFF-only names", "\ufeff", "\ufeff", "\ufeff", false],
  ["an empty preceding selector", "Fixture", "first", "perform:", true],
] as const)(
  "preserves %s in file-backed Apple metadata identities",
  async (_, className, propertyName, selector, emptyFirst) => {
    const directory = await createTestTempDirectory("rea-dispatch-strings-");
    const path = join(directory, "fixture.bin");
    const bytes = machoWithPropertyAttributes("Tq,N", {
      firstName: propertyName,
    });
    bytes.write(`${className}\0`, 0x400);
    const base = 0x100000000n;
    bytes.writeBigUInt64LE(base + 0x700n, 0x320);
    bytes.writeUInt32LE(24, 0x700);
    bytes.writeUInt32LE(1, 0x704);
    bytes.writeBigUInt64LE(base + 0x750n, 0x708);
    bytes.writeBigUInt64LE(base + 0x780n, 0x710);
    bytes.writeBigUInt64LE(base + 0x800n, 0x718);
    bytes.write(`${selector}\0`, 0x750);
    bytes.write("v@:\0", 0x780);
    const methodEntry = emptyFirst ? 0x720 : 0x708;
    if (emptyFirst) {
      bytes.copy(bytes, methodEntry, 0x708, 0x720);
      bytes.writeUInt32LE(2, 0x704);
      bytes.writeBigUInt64LE(base + 0x740n, 0x708);
    }
    await writeFile(path, bytes);
    const target = await parseBinaryTarget(path);
    if (!target.ok) throw target.error;
    const metadata = await withArtifactResourceScope((resources) =>
      resources.run(() =>
        inspectAppleDispatchMetadata(target.value, 100, resources),
      ),
    );
    expect(metadata.target_sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(metadata.result.objc_classes).toMatchObject([
      {
        name: className,
        methods: [{ selector }],
        properties: [{ name: propertyName }, { name: "second" }],
        location: { address: "0x100000200", file_offset: 0x200 },
        evidence: [
          {
            artifact_path: target.value.path,
            artifact_sha256: target.value.sha256,
            location: { address: "0x100000200", file_offset: 0x200 },
          },
        ],
      },
    ]);
    expect(metadata.result.objc_dispatch_implementations).toMatchObject([
      {
        class_name: className,
        selector,
        implementation_address: "0x100000800",
        location: {
          address: `0x${(base + BigInt(methodEntry)).toString(16)}`,
          file_offset: methodEntry,
        },
      },
    ]);
    expect(
      metadata.result.coverage.find(
        ({ facet }) => facet === "objc_properties_categories",
      ),
    ).toMatchObject({ status: "complete", reason: null });
    if (emptyFirst)
      expect(
        metadata.result.coverage.find(
          ({ facet }) => facet === "objc_class_method_ivar_metadata",
        ),
      ).toMatchObject({
        status: "partial",
        reason: expect.stringContaining("empty selector"),
      });
    expect(await readFile(path)).toEqual(bytes);
  },
);

it.each([
  ["malformed UTF-8", [0xef, 0xbb, 0]],
  ["an empty name", [0]],
] as const)(
  "keeps %s partial beside a valid Apple metadata identity",
  async (_, name) => {
    const directory = await createTestTempDirectory("rea-dispatch-strings-");
    const path = join(directory, "fixture.bin");
    const bytes = machoWithPropertyAttributes("Tq,N");
    // Invalid UTF-8 and a NUL-only name remain distinct from EF BB BF payload.
    bytes.set(name, 0x600);
    await writeFile(path, bytes);
    const target = await parseBinaryTarget(path);
    if (!target.ok) throw target.error;
    const metadata = await withArtifactResourceScope((resources) =>
      resources.run(() =>
        inspectAppleDispatchMetadata(target.value, 100, resources),
      ),
    );
    expect(metadata.result.objc_classes).toMatchObject([
      { name: "Fixture", properties: [{ name: "second" }] },
    ]);
    expect(
      metadata.result.coverage.find(
        ({ facet }) => facet === "objc_properties_categories",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("property_decode_failed"),
    });
    expect(await readFile(path)).toEqual(bytes);
  },
);
