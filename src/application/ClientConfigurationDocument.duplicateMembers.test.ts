import { describe, expect, it } from "vitest";

import {
  clientConfigurationValuesEqual,
  clientServerPath,
  parseClientConfiguration,
  serializeClientConfiguration,
  shadowedClientServers,
  withClientServers,
  type ClientConfigurationEditOptions,
} from "./ClientConfigurationDocument.js";

// JSON.parse, JSONC parse, and native clients keep the last repeated member.
// Every expectation reads the edited bytes with JSON.parse as an independent
// reader, not only with REA's own parser.
const entry = { command: "rea", args: ["mcp"] };
const shadow = '{"command": "/usr/bin/false"}';
const active = '{"command": "/usr/bin/true"}';
// Spelled at run time so no tool decodes the escapes in this source.
const BACKSLASH = "\\";

/** Server tables a parent member can hold, including repeated `rea` members. */
const TABLES = [
  "{}",
  `{"peer": ${active}}`,
  `{"rea": ${shadow}}`,
  `{"rea": ${shadow}, "peer": ${active}}`,
  `{"peer": ${active}, "rea": ${active}}`,
  `{"rea": ${shadow}, "peer": ${active}, "rea": ${active}}`,
  `{"rea": ${shadow}, "rea": ${shadow}, "rea": ${active}}`,
] as const;

/** Every document with one to three repeated `mcpServers` parents. */
const layouts = (): readonly (readonly string[])[] => {
  const result: string[][] = TABLES.map((table) => [table]);
  for (let depth = 1; depth < 3; depth += 1)
    for (const prefix of result.filter((parents) => parents.length === depth))
      for (const table of TABLES) result.push([...prefix, table]);
  return result;
};

const cases = layouts().flatMap((parents) =>
  (["\n", "\r\n"] as const).flatMap((newline) =>
    (["", "﻿"] as const).map((bom) => ({
      parents,
      bom,
      text: `${bom}{${newline}  "theme": "dark",${newline}${parents
        .map((table) => `  "mcpServers": ${table}`)
        .join(`,${newline}`)}${newline}}${newline}`,
    })),
  ),
);

const nativeRead = (text: string): Record<string, unknown> =>
  JSON.parse(text.replace(/^﻿/u, "")) as Record<string, unknown>;

const nativeServers = (text: string): Record<string, unknown> =>
  nativeRead(text).mcpServers as Record<string, unknown>;

/** Remove REA's server from `text` as uninstall does. */
const removeRea = (
  text: string,
  format: "claude_code" | "json",
  options?: ClientConfigurationEditOptions,
) => {
  const parsed = parseClientConfiguration(text, format);
  const { rea: removed, ...remaining } = parsed.servers;
  void removed;
  return {
    parsed,
    remaining,
    result: serializeClientConfiguration(
      withClientServers(parsed, remaining),
      format,
      text,
      [clientServerPath(parsed, "rea")],
      options,
    ),
  };
};

describe("JSON client configuration with repeated members", () => {
  it("enumerates every layout", () => {
    expect(cases).toHaveLength((7 + 7 ** 2 + 7 ** 3) * 4);
  });

  it.each(["claude_code", "json"] as const)(
    "%s setup edits the member clients read and keeps shadowed members",
    (format) => {
      for (const { parents, text, bom } of cases) {
        const parsed = parseClientConfiguration(text, format);
        const desired = withClientServers(parsed, {
          ...parsed.servers,
          rea: entry,
        });
        const result = serializeClientConfiguration(desired, format, text, [
          clientServerPath(parsed, "rea"),
        ]);
        const label = JSON.stringify(text);
        if (!result.ok) throw new Error(`setup refused ${label}`);
        const edited = result.value;
        expect(nativeServers(edited).rea, label).toEqual(entry);
        expect(
          clientConfigurationValuesEqual(nativeRead(edited), desired),
          label,
        ).toBe(true);
        for (const table of parents.slice(0, -1))
          expect(edited, label).toContain(`"mcpServers": ${table}`);
        expect(edited.startsWith(`${bom}{`), label).toBe(true);
      }
    },
  );

  it.each(["claude_code", "json"] as const)(
    "%s removal without authority refuses only a repeated effective member",
    (format) => {
      for (const { text } of cases) {
        const { parsed, result } = removeRea(text, format);
        const label = JSON.stringify(text);
        const repeats = shadowedClientServers(text, parsed, "rea").servers;
        // The serializer reads a full syntax tree; the uninstall decision
        // reads shadowedClientServers. Both must see the same repeats.
        expect(result, label).toEqual(
          repeats.length === 0
            ? { ok: true, value: expect.any(String) }
            : {
                ok: false,
                error: { kind: "shadowed_member", path: ["mcpServers", "rea"] },
              },
        );
      }
    },
  );

  it.each(["claude_code", "json"] as const)(
    "%s removal with authority deletes every repeated member of the effective table",
    (format) => {
      for (const { parents, text } of cases) {
        const { parsed, remaining, result } = removeRea(text, format, {
          removeShadowedMembers: true,
        });
        const label = JSON.stringify(text);
        if (!result.ok) throw new Error(`removal refused ${label}`);
        const edited = result.value;
        expect(Object.hasOwn(nativeServers(edited), "rea"), label).toBe(false);
        expect(nativeServers(edited), label).toEqual(remaining);
        expect(
          shadowedClientServers(
            edited,
            parseClientConfiguration(edited, format),
            "rea",
          ),
          label,
        ).toEqual({ servers: [], legacyServers: [] });
        // Inactive parents keep their bytes, and documents without REA's
        // member are returned unchanged.
        for (const table of parents.slice(0, -1))
          expect(edited, label).toContain(`"mcpServers": ${table}`);
        if (!Object.hasOwn(parsed.servers, "rea"))
          expect(edited, label).toBe(text);
      }
    },
  );

  it("reports earlier members of a repeated name in document order", () => {
    const text = `{"mcpServers": {"rea": 1}, "mcpServers": {"r\\u0065a": 2, "peer": 3, "rea": 4, "peer": 5}}`;
    const parsed = parseClientConfiguration(text, "claude_code");
    expect(parsed.servers).toEqual({ rea: 4, peer: 5 });
    // Escaped names are the same member; the inactive parent is not read.
    expect(shadowedClientServers(text, parsed, "rea")).toEqual({
      servers: [2],
      legacyServers: [],
    });
    expect(shadowedClientServers(text, parsed, "peer").servers).toEqual([3]);
    // A repeated token outside the server table is not a repeated member.
    const value = `{"note": "rea", "mcpServers": {"rea": 1}}`;
    expect(
      shadowedClientServers(
        value,
        parseClientConfiguration(value, "json"),
        "rea",
      ),
    ).toEqual({ servers: [], legacyServers: [] });
  });

  // The prefilter must never miss a spelling that JSON.parse decodes to `name`.
  it.each([
    ["a unicode escape", "z/", `"z${BACKSLASH}u002F"`],
    ["a lowercase hex digit", "z/", `"${BACKSLASH}u007a/"`],
    ["an uppercase hex digit", "z/", `"${BACKSLASH}u007A/"`],
    ["a short escape", "z/", String.raw`"z\/"`],
    ["an escaped quote", 'a"b', String.raw`"a\"b"`],
    ["an escaped backslash", String.raw`a\b`, String.raw`"a\\b"`],
  ] as const)("finds a repeat spelled with %s", (_label, name, spelling) => {
    const text = `{"mcpServers": {${spelling}: 1, ${JSON.stringify(name)}: 2}}`;
    const parsed = parseClientConfiguration(text, "json");
    expect(parsed.servers).toEqual({ [name]: 2 });
    expect(shadowedClientServers(text, parsed, name).servers).toEqual([1]);
  });

  it("reports repeated OpenCode V1 members beside a native V2 table", () => {
    const text = `{"mcp": {"servers": {"rea": {"type": "local", "command": ["a"]}}, "rea": 1, "timeout": 2, "timeout": 3, "rea": 4}}`;
    const parsed = parseClientConfiguration(text, "opencode");
    expect(parsed.dialect).toBe("opencode_v2");
    expect(parsed.legacyServers).toEqual({ rea: 4 });
    // V2 settings such as `timeout` are not servers.
    expect(shadowedClientServers(text, parsed, "rea")).toEqual({
      servers: [],
      legacyServers: [1],
    });
    expect(shadowedClientServers(text, parsed, "timeout")).toEqual({
      servers: [],
      legacyServers: [],
    });
  });

  it("removes escaped spellings and keeps JSONC comments and separators valid", () => {
    const text = `{\n  // keep\n  "mcpServers": {\n    "r\\u0065a": 1, // a\n    "peer": 2,\n    /* b */ "rea": 3,\n  },\n}\n`;
    const { result } = removeRea(text, "json", { removeShadowedMembers: true });
    if (!result.ok) throw new Error("removal refused");
    expect(result.value).toContain("// keep");
    expect(result.value).toContain("// a");
    expect(result.value).toContain("/* b */");
    expect(result.value).not.toMatch(/"r(?:\\u0065|e)a"/u);
    expect(parseClientConfiguration(result.value, "json").document).toEqual({
      mcpServers: { peer: 2 },
    });
  });
});

describe("JSON client configuration with many repeated members", () => {
  it("removes tens of thousands of repeats in one pass", () => {
    // Repeats alternate with peers and comments, so every separator case occurs.
    const members = Array.from(
      { length: 20_000 },
      (_, index) =>
        `"rea": ${String(index)}, /* ${String(index)} */ "p${String(index)}": ${String(index)}`,
    );
    const text = `{"mcpServers": {"rea": -1, ${members.join(",\n")}, "rea": -2}}`;
    const { remaining, result } = removeRea(text, "json", {
      removeShadowedMembers: true,
    });
    if (!result.ok) throw new Error("removal refused");
    expect(Object.keys(remaining)).toHaveLength(20_000);
    expect(parseClientConfiguration(result.value, "json").document).toEqual({
      mcpServers: remaining,
    });
    expect(result.value).not.toContain('"rea"');
    expect(result.value).toContain("/* 19999 */");
  });
});
