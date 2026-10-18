import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

// JSON.parse, JSONC parse, and native Claude Code read the last duplicate.
const shadowParent = '"mcpServers": {"shadow": {"command": "/usr/bin/false"}},';
const shadowLeaf = '"rea": {"command": "/usr/bin/false"},';
const owned =
  '"rea": {"command": "npx", "args": ["-y", "rea-agents@6.6.0", "mcp"]}';

const runIn = (cli: TestCli, home: string) => (arguments_: readonly string[]) =>
  cli.run({
    arguments: arguments_,
    cwd: home,
    environment: {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  });

const setupArguments = (client: string) =>
  ["setup", "--client", client, "--skill=false", "--json", "--yes"] as const;

for (const [layout, original] of [
  [
    "a repeated server table",
    `{\n  ${shadowParent}\n  "mcpServers": {"peer": {"command": "/usr/bin/true"}}\n}\n`,
  ],
  [
    "a repeated rea member",
    `{\n  "mcpServers": {${shadowLeaf} "rea": {"command": "/usr/bin/true"}}\n}\n`,
  ],
] as const)
  cliTest(
    `Claude Code setup edits the effective member of ${layout}`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-json-duplicate-");
      const config = join(home, ".claude.json");
      await writeFile(config, original);
      const run = runIn(cli, home);

      const setup = await run(setupArguments("claude_code"));
      expect(setup.exitCode, setup.stdout).toBe(0);
      expect(setup.json).toMatchObject({
        status: "ready",
        clients: { claude_code: { status: "configured" } },
      });
      expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
      const configured = await readFile(config, "utf8");
      expect(configured).toContain(
        layout === "a repeated server table" ? shadowParent : shadowLeaf,
      );
      expect(JSON.parse(configured)).toMatchObject({
        mcpServers: { rea: { command: expect.not.stringMatching(/^\/usr/) } },
      });

      const repeated = await run(setupArguments("claude_code"));
      expect(repeated.exitCode, repeated.stdout).toBe(0);
      expect(repeated.json).toMatchObject({
        status: "ready",
        plannedActions: [],
      });
      expect(await readFile(config, "utf8")).toBe(configured);
    },
  );

cliTest(
  "JSONC setup keeps comments and the shadowed server table",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-jsonc-duplicate-");
    await mkdir(join(home, ".cursor"));
    const config = join(home, ".cursor", "mcp.json");
    const head = `{\n  // shadowed table\n  ${shadowParent}\n  /* effective table */\n`;
    await writeFile(
      config,
      `${head}  "mcpServers": {\n    "peer": {"command": "/usr/bin/true"} // peer\n  }\n}\n`,
    );

    const setup = await runIn(cli, home)(setupArguments("cursor"));
    expect(setup.exitCode, setup.stdout).toBe(0);
    expect(setup.json).toMatchObject({
      clients: { cursor: { status: "configured" } },
    });
    const configured = await readFile(config, "utf8");
    expect(configured.startsWith(head)).toBe(true);
    expect(configured).toContain("// peer");
    expect(configured.indexOf('"rea"')).toBeGreaterThan(head.length);
  },
);

cliTest(
  "uninstall removes an owned registration from the effective server table",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-json-duplicate-");
    const config = join(home, ".claude.json");
    const original = `{\n  ${shadowParent}\n  "mcpServers": {"peer": {"command": "/usr/bin/true"}, ${owned}}\n}\n`;
    await writeFile(config, original);

    const removed = await runIn(cli, home)(["uninstall", "--json"]);
    expect(removed.exitCode, removed.stdout).toBe(0);
    expect(removed.json).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: "claude_code", status: "removed" }),
      ]),
    });
    const remaining = await readFile(config, "utf8");
    expect(remaining.startsWith(`{\n  ${shadowParent}\n`)).toBe(true);
    expect(JSON.parse(remaining)).toEqual({
      mcpServers: { peer: { command: "/usr/bin/true" } },
    });
  },
);

cliTest(
  "uninstall refuses to activate a shadowed duplicate registration",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-json-duplicate-");
    const config = join(home, ".claude.json");
    const original = `{\n  "mcpServers": {${shadowLeaf} ${owned}}\n}\n`;
    await writeFile(config, original);

    const removed = await runIn(cli, home)(["uninstall", "--json"]);
    expect(removed.exitCode, removed.stdout).toBe(1);
    expect(removed.json).toMatchObject({
      status: "failed",
      items: expect.arrayContaining([
        expect.objectContaining({
          name: "claude_code",
          status: "failed",
          detail: expect.stringContaining("activate an earlier duplicate"),
        }),
      ]),
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(readFile(`${config}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

// Spelled at run time so the fixture file keeps the JSON escape.
const BACKSLASH = "\\";
const ownedLauncher = (version: string) =>
  `{"command": "npx", "args": ["-y", "rea-agents@${version}", "mcp"]}`;
const openCodeOwned =
  '{"type": "local", "command": ["npx", "-y", "rea-agents@6.6.0", "mcp"]}';
const openCodeForeign = '{"type": "local", "command": ["/usr/bin/false"]}';

const writeConfiguration = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

cliTest(
  "uninstall removes every repeated member when REA owns each one",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-json-duplicate-");
    const config = join(home, ".claude.json");
    // The escaped spelling names the same member for JSON.parse.
    const original = `{\n  "mcpServers": {"rea": ${ownedLauncher("6.6.0")}, "peer": {"command": "/usr/bin/true"}, "r${BACKSLASH}u0065a": ${ownedLauncher("6.5.0")}}\n}\n`;
    expect(original).toContain(`"r${BACKSLASH}u0065a"`);
    await writeFile(config, original);

    const removed = await runIn(cli, home)(["uninstall", "--json"]);
    expect(removed.exitCode, removed.stdout).toBe(0);
    expect(removed.json).toMatchObject({
      status: "complete",
      items: expect.arrayContaining([
        expect.objectContaining({ name: "claude_code", status: "removed" }),
      ]),
    });
    const remaining = await readFile(config, "utf8");
    expect(JSON.parse(remaining)).toEqual({
      mcpServers: { peer: { command: "/usr/bin/true" } },
    });
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
  },
);

cliTest(
  "uninstall removes repeated OpenCode V2 and V1 members that REA owns",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-json-duplicate-");
    const config = join(home, ".config/opencode/opencode.json");
    await writeConfiguration(
      config,
      `{\n  // keep\n  "mcp": {\n    "servers": {"rea": ${openCodeOwned}, "rea": ${openCodeOwned}},\n    "rea": ${openCodeOwned}, // legacy\n    "rea": ${openCodeOwned},\n  },\n}\n`,
    );

    const removed = await runIn(cli, home)(["uninstall", "--json"]);
    expect(removed.exitCode, removed.stdout).toBe(0);
    const remaining = await readFile(config, "utf8");
    expect(remaining).toContain("// keep");
    expect(remaining).not.toContain('"rea"');
  },
);

cliTest(
  "uninstall refuses an unowned repeat before changing any client",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-json-duplicate-");
    // Claude Code is removed before OpenCode, so a refusal found only while
    // editing OpenCode would leave Claude Code already changed.
    const claude = join(home, ".claude.json");
    const claudeOriginal = `{\n  "mcpServers": {${owned}}\n}\n`;
    await writeFile(claude, claudeOriginal);
    const openCode = join(home, ".config/opencode/opencode.json");
    const openCodeOriginal = `{\n  "mcp": {\n    "servers": {"rea": ${openCodeOwned}},\n    "rea": ${openCodeForeign},\n    "rea": ${openCodeOwned}\n  }\n}\n`;
    await writeConfiguration(openCode, openCodeOriginal);

    const removed = await runIn(cli, home)(["uninstall", "--json"]);
    expect(removed.exitCode, removed.stdout).toBe(1);
    expect(removed.json).toMatchObject({
      status: "failed",
      items: expect.arrayContaining([
        expect.objectContaining({
          name: "opencode",
          status: "failed",
          detail: expect.stringContaining("is not REA-owned"),
        }),
        expect.objectContaining({ name: "uninstall", status: "skipped" }),
      ]),
    });
    expect(await readFile(claude, "utf8")).toBe(claudeOriginal);
    expect(await readFile(openCode, "utf8")).toBe(openCodeOriginal);
    for (const path of [claude, openCode])
      await expect(readFile(`${path}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);

cliTest(
  "OpenCode setup replaces every repeat of REA's V1 entry beside a V2 table",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-json-duplicate-");
    const config = join(home, ".config/opencode/opencode.json");
    await writeConfiguration(
      config,
      `{\n  "mcp": {\n    "servers": {"peer": {"type": "local", "command": ["/usr/bin/true"]}},\n    "rea": ${openCodeForeign},\n    "rea": ${openCodeForeign}\n  }\n}\n`,
    );

    const setup = await runIn(cli, home)(setupArguments("opencode"));
    expect(setup.exitCode, setup.stdout).toBe(0);
    expect(setup.json).toMatchObject({
      clients: { opencode: { status: "configured" } },
    });
    const { mcp } = JSON.parse(await readFile(config, "utf8")) as {
      mcp: Record<string, unknown> & { servers: Record<string, unknown> };
    };
    // The native entry supersedes REA's V1 name, as it does for one member.
    expect(Object.hasOwn(mcp, "rea")).toBe(false);
    expect(mcp.servers).toMatchObject({
      peer: { command: ["/usr/bin/true"] },
      rea: { type: "local" },
    });
  },
);

for (const [layout, servers] of [
  ["one native entry", `"rea": ${openCodeOwned}`],
  [
    "repeated native entries",
    `"rea": ${openCodeOwned}, "rea": ${openCodeOwned}`,
  ],
] as const)
  cliTest(
    `uninstall keeps ${layout} when OpenCode would fall back to a foreign V1 entry`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-json-duplicate-");
      const config = join(home, ".config/opencode/opencode.json");
      // Without the native entry, OpenCode loads the V1 `mcp.rea` member.
      const original = `{\n  "mcp": {\n    "servers": {${servers}},\n    "rea": ${openCodeForeign}\n  }\n}\n`;
      await writeConfiguration(config, original);

      const removed = await runIn(cli, home)(["uninstall", "--json"]);
      expect(removed.exitCode, removed.stdout).toBe(1);
      expect(removed.json).toMatchObject({
        status: "failed",
        items: expect.arrayContaining([
          expect.objectContaining({
            name: "opencode",
            status: "failed",
            detail: expect.stringContaining("would activate it"),
          }),
        ]),
      });
      expect(await readFile(config, "utf8")).toBe(original);
      await expect(readFile(`${config}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
