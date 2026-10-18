import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  resolveWakaruCommand,
  resolveWakaruLimiter,
  wakaruRecoveryConfigured,
} from "../../../src/javascript/recovery/WakaruCommand.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("refuses a directory configured as the Wakaru resource limiter", async () => {
  const root = await createTestTempDirectory("rea-wakaru-limiter-");
  const command = join(root, "wakaru");
  const limiter = join(root, "prlimit");
  await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
  await mkdir(limiter);

  await expect(
    resolveWakaruCommand({
      REA_WAKARU_COMMAND: command,
      REA_JAVASCRIPT_PRLIMIT_COMMAND: limiter,
    }),
  ).rejects.toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    reason: expect.stringContaining(limiter),
  });
});

it("treats an absent default Linux limiter as no limiter", async () => {
  // A Linux host that ships Wakaru without util-linux must still recover: the
  // default path is a probe, so a miss degrades to "unenforced", not a refusal.
  const root = await createTestTempDirectory("rea-wakaru-default-limiter-");
  const missing = join(root, "prlimit");

  await expect(
    resolveWakaruLimiter(undefined, {
      platform: "linux",
      defaultLimiter: missing,
    }),
  ).resolves.toBeUndefined();
});

it("keeps the default Linux limiter when it is executable", async () => {
  const root = await createTestTempDirectory("rea-wakaru-default-limiter-");
  const limiter = join(root, "prlimit");
  await writeFile(limiter, "#!/bin/sh\n", { mode: 0o700 });

  await expect(
    resolveWakaruLimiter(undefined, {
      platform: "linux",
      defaultLimiter: limiter,
    }),
  ).resolves.toBe(limiter);
});

it("still fails closed when an explicitly configured limiter is missing", async () => {
  const root = await createTestTempDirectory("rea-wakaru-default-limiter-");
  const limiter = join(root, "prlimit");

  await expect(
    resolveWakaruLimiter(limiter, { platform: "linux" }),
  ).rejects.toThrow(/Resource limiter/);
});

it.skipIf(process.platform === "linux" || process.platform === "win32")(
  "keeps the command reachable without a limiter and warns once",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-no-limiter-");
    const command = join(root, "wakaru");
    await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
    const warnings: string[] = [];
    const warn = (event: { message: string }): void => {
      warnings.push(event.message);
    };

    const resolved = await resolveWakaruCommand(
      { REA_WAKARU_COMMAND: command },
      { warn },
    );
    expect(resolved.limiter).toBeUndefined();
    expect(resolved.host.addressSpaceLimit).toBe("unenforced");
    await resolveWakaruCommand({ REA_WAKARU_COMMAND: command }, { warn });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("REA_JAVASCRIPT_PRLIMIT_COMMAND");
  },
);

// Windows needs Developer Mode or elevation to create file symlinks (EPERM).
it.skipIf(process.platform === "win32")(
  "allows a symlink to a regular Wakaru resource limiter",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-limiter-symlink-");
    const command = join(root, "wakaru");
    const limiter = join(root, "prlimit");
    const target = join(root, "prlimit-bin");
    await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(target, "#!/bin/sh\n", { mode: 0o700 });
    await symlink(target, limiter);

    await expect(
      resolveWakaruCommand({
        REA_WAKARU_COMMAND: command,
        REA_JAVASCRIPT_PRLIMIT_COMMAND: limiter,
      }),
    ).resolves.toMatchObject({ limiter });
  },
);

// The availability policy is the caller-facing half of the same admission rule
// the launch path applies, so the two must agree on every configuration shape.
// An executable bit carries the rule on POSIX hosts; Windows admits any regular
// file there.
it.skipIf(process.platform === "win32")(
  "keeps the advertised configuration aligned with launch-time limiter admission",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-limiter-admission-");
    const command = join(root, "wakaru");
    const executable = join(root, "prlimit");
    const notExecutable = join(root, "prlimit-not-executable");
    const directory = join(root, "limiter-dir");
    await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(notExecutable, "#!/bin/sh\n", { mode: 0o600 });
    await mkdir(directory);

    const cases: readonly (readonly [string, boolean])[] = [
      [executable, true],
      ["prlimit", false],
      [join(root, "missing"), false],
      [notExecutable, false],
      [directory, false],
    ];
    for (const [limiter, admitted] of cases) {
      expect(
        wakaruRecoveryConfigured({
          REA_WAKARU_COMMAND: command,
          REA_JAVASCRIPT_PRLIMIT_COMMAND: limiter,
        }),
      ).toBe(admitted);
      const launch = resolveWakaruLimiter(limiter, { platform: "linux" });
      if (admitted) await expect(launch).resolves.toBe(limiter);
      else await expect(launch).rejects.toThrow(TypeError);
    }

    // An absent limiter is a probe result, not a rejection: the host still runs.
    expect(wakaruRecoveryConfigured({ REA_WAKARU_COMMAND: command })).toBe(
      true,
    );
    await expect(
      resolveWakaruLimiter(undefined, { platform: "darwin" }),
    ).resolves.toBeUndefined();

    // A relative binary is never advertised, matching the launch refusal.
    expect(wakaruRecoveryConfigured({ REA_WAKARU_COMMAND: "wakaru" })).toBe(
      false,
    );
  },
);
