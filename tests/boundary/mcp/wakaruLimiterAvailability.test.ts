import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/**
 * An explicitly configured limiter is a caller requirement that fails closed at
 * launch, so an unusable override must not be advertised as available: clients
 * would be steered into a call that can never succeed.
 */
vi.mock("../../../src/process/ProviderProcessOwnership.js", () => ({
  providerProcessOwnershipAvailable: () => true,
}));

const availabilityFor = async (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const session = createTestBinarySession(createCacheProvider([]));
  const server = createServer(
    { kind: "session", session },
    { environment, logger: silentLogger },
  );
  const client = new Client({
    name: "wakaru-limiter-availability",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const reply = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    const result = toolContract("binary_session").outputSchema.parse(
      reply.structuredContent,
    ).result;
    return expandToolAvailability(result.tool_availability).find(
      (tool) => tool.name === "recover_javascript_sources",
    );
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
};

const command = "/opt/wakaru/bin/wakaru";

// The executable bit carries the admission rule on POSIX hosts; Windows has no
// equivalent, and `resolveWakaruLimiter` admits any regular file there.
it.skipIf(process.platform === "win32")(
  "does not advertise recovery when the configured limiter cannot be admitted",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-limiter-gate-");
    const notExecutable = join(root, "prlimit");
    const directory = join(root, "prlimit-dir");
    await writeFile(notExecutable, "#!/bin/sh\n", { mode: 0o600 });
    await mkdir(directory);

    for (const limiter of [
      "prlimit",
      join(root, "missing"),
      notExecutable,
      directory,
    ])
      expect(
        await availabilityFor({
          REA_WAKARU_COMMAND: command,
          REA_JAVASCRIPT_PRLIMIT_COMMAND: limiter,
        }),
      ).toMatchObject({ available: false, reason: "provider_missing" });
  },
);

it("advertises recovery for an admitted limiter override and for none", async () => {
  const root = await createTestTempDirectory("rea-wakaru-limiter-gate-");
  const limiter = join(root, "prlimit");
  await writeFile(limiter, "#!/bin/sh\n", { mode: 0o700 });

  expect(
    await availabilityFor({
      REA_WAKARU_COMMAND: command,
      REA_JAVASCRIPT_PRLIMIT_COMMAND: limiter,
    }),
  ).toMatchObject({ available: true, reason: "available" });
  expect(await availabilityFor({ REA_WAKARU_COMMAND: command })).toMatchObject({
    available: true,
    reason: "available",
  });
});
