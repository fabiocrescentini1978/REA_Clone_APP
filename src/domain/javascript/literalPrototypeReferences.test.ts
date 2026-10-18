import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const READ = 'new (Q("electron").BrowserWindow)({});';

describe("literal prototype reference sources", () => {
  it.each([
    "const holder={__proto__:{target:module}};holder.target.require=other;",
    "const holder={__proto__:{__proto__:{target:module}}};holder.target.require=other;",
    "const proto={target:module};const holder={__proto__:proto};holder.target.require=other;",
    "const {target}={__proto__:{target:module}};target.require=other;",
    "const holder={__proto__:{nested:{target:module}}};holder.nested.target.require=other;",
    "const holder={__proto__:{get target(){return module}}};holder.target.require=other;",
    "const holder={__proto__:flag?{target:module}:{}};holder.target.require=other;",
    "const holder={__proto__:{target:module}};holder[key].require=other;",
    "const holder={__proto__:{target:module}};const saved=holder.target;holder.target={};saved.require=other;",
    "const proto={target:{}};const holder={__proto__:proto};proto.target=module;holder.target.require=other;",
    "const holder={target:{},__proto__:{target:module}};delete holder.target;holder.target.require=other;",
    "const holder={target:{},__proto__:{target:module}};holder.target=module;holder.target.require=other;",
    "let proto={target:module};const holder={__proto__:proto};proto={};holder.target.require=other;",
    'const holder={["__proto__"]:{target:module}};holder.__proto__.target.require=other;',
    "const holder={...{target:module},__proto__:{}};holder.target.require=other;",
  ])("retains a possible inherited delegate write: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(`${SHIM}${setup}${READ}`).electron
        .browser_windows,
    ).toEqual([]);
  });

  it.each([
    "const holder={target:{},__proto__:{target:module}};holder.target.require=other;",
    "const holder={__proto__:{target:module},target:{}};holder.target.require=other;",
    "const holder={__proto__:{target:module},get target(){return {}}};holder.target.require=other;",
    "const holder={__proto__:null,target:{}};holder.target.require=other;",
    "const holder={__proto__:1,target:{}};holder.target.require=other;",
    'const holder={["__proto__"]:{target:module}};holder.target.require=other;',
    "const __proto__={target:module};const holder={__proto__};holder.target.require=other;",
    "const holder={__proto__:{target:{}}};holder.target.require=other;",
    "const holder={target:{},__proto__:{target:module}};const saved=holder.target;delete holder.target;saved.require=other;",
    "const proto={target:{}};const holder={__proto__:proto};const saved=holder.target;proto.target=module;saved.require=other;",
    "let proto={target:{}};const holder={__proto__:proto};proto={target:module};holder.target.require=other;",
  ])("keeps an unrelated own or inherited target local: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(`${SHIM}${setup}${READ}`).electron
        .browser_windows,
    ).toHaveLength(1);
  });
});
