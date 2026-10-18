import { describe, expect, it } from "vitest";

import { ROLLDOWN_MODULE_INTEROP } from "./javascriptModuleInterop.fixture.js";
import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const read = (loader = "Q") =>
  `new (__toESM(${loader}("electron"),1).BrowserWindow)({});`;
const windows = (source: string) => {
  const result = analyzeJavaScriptStaticSource(source);
  expect(result.parse_error_count).toBe(0);
  return result.electron.browser_windows;
};

describe("namespace helper binding integrity", () => {
  it.each([
    "globalThis.__toESM=()=>({BrowserWindow:Fake});",
    'const root=globalThis;root["__toESM"]=other;',
    'Reflect.set(globalThis,"__toESM",other);',
    'Object.defineProperty(globalThis,"__toESM",{value:other});',
    'eval("__toESM=other");',
    '(0,eval)("__toESM=other");',
    "globalThis.__copyProps=other;",
    "globalThis.__create=other;",
    "globalThis.__getProtoOf=other;",
    "globalThis.__defProp=other;",
    "globalThis.__getOwnPropNames=other;",
    "globalThis.__getOwnPropDesc=other;",
    "globalThis.__hasOwnProp=other;",
  ])("rejects a helper whose live binding changed: %s", (write) => {
    for (const loader of ["require", "Q"])
      expect(
        windows(`${ROLLDOWN_MODULE_INTEROP}${SHIM}${write}${read(loader)}`),
      ).toEqual([]);
  });

  it.each([
    'new (__toESM(Q("electron"),1).BrowserWindow)({});globalThis.__toESM=other;',
    'const ns=__toESM(Q("electron"),1);globalThis.__toESM=other;new ns.BrowserWindow({});',
    'const ns=__toESM(Q("electron"),1);globalThis.__copyProps=other;new ns.BrowserWindow({});',
    'const ns=__toESM(Q("electron"),1);globalThis.__create=other;new ns.BrowserWindow({});',
  ])(
    "preserves conversion completed before later replacement: %s",
    (consumer) => {
      expect(
        windows(`${ROLLDOWN_MODULE_INTEROP}${SHIM}${consumer}`),
      ).toHaveLength(1);
    },
  );

  it("keeps the global slot separate from a lexical helper", () => {
    const helpers = ROLLDOWN_MODULE_INTEROP.replace(
      "var __toESM",
      "const __toESM",
    );
    expect(
      windows(`${helpers}${SHIM}globalThis.__toESM=other;${read()}`),
    ).toHaveLength(1);
  });

  it("keeps module-local vars separate from global properties", () => {
    expect(
      windows(
        `export {};${ROLLDOWN_MODULE_INTEROP}${SHIM}globalThis.__toESM=other;${read()}`,
      ),
    ).toHaveLength(1);
  });

  it.each(["var identity=mod=>mod;", "function identity(mod){return mod;}"])(
    "checks the live binding of an identity helper: %s",
    (helper) => {
      expect(
        windows(
          `${SHIM}${helper}globalThis.identity=other;new (identity(Q("electron")).BrowserWindow)({});`,
        ),
      ).toEqual([]);
    },
  );

  it.each([
    'const ns=__toESM(Q("node:module"),1);ns.default.prototype.require=other;',
    'const ns=__toESM(Q("node:process"),1);ns.default.mainModule.constructor._load=other;',
  ])(
    "retains possible input aliases when helper invocation is uncertain: %s",
    (mutation) => {
      expect(
        windows(
          `${ROLLDOWN_MODULE_INTEROP}${SHIM}if(flag)globalThis.__toESM=other;${mutation}new (Q("electron").BrowserWindow)({});`,
        ),
      ).toEqual([]);
    },
  );

  it("retains replacement before a hoisted helper's declaration", () => {
    expect(
      windows(
        `${SHIM}globalThis.identity=other;function identity(mod){return mod;}new (identity(Q("electron")).BrowserWindow)({});`,
      ),
    ).toEqual([]);
  });

  it.each([
    ["__create", "Object.create"],
    ["__defProp", "Object.defineProperty"],
  ])("checks supplier aliases when %s is captured", (role, intrinsic) => {
    const helpers = ROLLDOWN_MODULE_INTEROP.replace(
      `var ${role} = ${intrinsic};`,
      `var supplier=${intrinsic};globalThis.supplier=other;var ${role}=supplier;`,
    );
    expect(windows(`${helpers}${SHIM}${read()}`)).toEqual([]);
  });

  it("preserves a supplier captured before its alias is replaced", () => {
    const helpers = ROLLDOWN_MODULE_INTEROP.replace(
      "var __create = Object.create;",
      "var supplier=Object.create;var __create=supplier;globalThis.supplier=other;",
    );
    expect(windows(`${helpers}${SHIM}${read()}`)).toHaveLength(1);
  });

  it("keeps deferred global writes uncertain for script helper slots", () => {
    expect(
      windows(`${ROLLDOWN_MODULE_INTEROP}
      Object.create=customCreate;
      let electron=require("electron");electron=__toESM(electron,1);
      function runLoop(key){globalThis[key]=this;}
      function polyfill(){Object.create=customCreate;}
      new electron.BrowserWindow({});
    `),
    ).toEqual([]);
  });

  it("rejects explicit replacement of a CommonJS-local helper", () => {
    const source = `${ROLLDOWN_MODULE_INTEROP}${SHIM}__toESM=other;${read()}`;
    const parsed = parseJavaScriptSource(source, "vendor-main.cjs");
    expect(parsed).not.toBeNull();
    expect(
      analyzeParsedJavaScriptStaticSource(source, parsed!).electron
        .browser_windows,
    ).toEqual([]);
  });

  it("captures the invoked helper before evaluating its arguments", () => {
    expect(
      windows(`${ROLLDOWN_MODULE_INTEROP}${SHIM}
      new (__toESM(require("electron",globalThis.__toESM=other),1).BrowserWindow)({});
    `),
    ).toHaveLength(1);
  });

  it("reads supporting helper roles after evaluating arguments", () => {
    expect(
      windows(`${ROLLDOWN_MODULE_INTEROP}${SHIM}
      new (__toESM(require("electron",globalThis.__copyProps=other),1).BrowserWindow)({});
    `),
    ).toEqual([]);
  });
});
