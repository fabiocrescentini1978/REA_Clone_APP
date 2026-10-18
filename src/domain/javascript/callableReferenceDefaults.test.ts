import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const READ = 'new (Q("electron").BrowserWindow)({});';

describe("callable own slots in destructuring defaults", () => {
  it.each([
    "const {prototype:target=globalThis}=function(){};",
    "const {prototype:target=globalThis}=function*(){};",
    "const {prototype:target=globalThis}=async function*(){};",
    "const {nested:{prototype:target=globalThis}}={nested:function(){}};",
    "const {prototype:target=globalThis}={__proto__:function(){}};",
    "const {name:target=globalThis}=function(){};",
    "const {length:target=globalThis}=function(){};",
    "const {name:target=globalThis}=()=>{};",
    "const {length:target=globalThis}=async()=>{};",
    "const {name:target=globalThis}=async function(){};",
    "const {length:target=globalThis}=function*(){};",
    "const {method:{name:target=globalThis}}={method(){}};",
    "const {method:{length:target=globalThis}}={async method(){}};",
    "const {method:{prototype:target=globalThis}}={*method(){}};",
    "const {method:{prototype:target=globalThis}}={async *method(){}};",
    "const {prototype:target=globalThis,prototype:saved,t:unused=(saved.constructor.prototype=undefined)}=function(){};",
  ])(
    "excludes a fallback after selecting a guaranteed own slot: %s",
    (setup) => {
      expect(
        analyzeJavaScriptStaticSource(`${SHIM}${setup}target.Q=other;${READ}`)
          .electron.browser_windows,
      ).toHaveLength(1);
    },
  );

  it.each([
    "const {prototype:target=globalThis}=()=>{};",
    "const {prototype:target=globalThis}=async()=>{};",
    "const {prototype:target=globalThis}=async function(){};",
    "const {method:{prototype:target=globalThis}}={method(){}};",
    "const {method:{prototype:target=globalThis}}={async method(){}};",
    "const {prototype:{missing:target=globalThis}}=function(){};",
    "const {name:{missing:target=globalThis}}=function(){};",
    "const {method:{name:target=globalThis}}={get method(){return unknown}};",
    "const source=function(){};source.prototype=undefined;const {prototype:target=globalThis}=source;",
    "const {prototype:saved,t:unused=(saved.constructor.prototype=undefined),prototype:target=globalThis}=function(){};",
    "const {prototype:saved,[(saved.constructor.prototype=undefined,'unused')]:unused,prototype:target=globalThis}=function(){};",
  ])(
    "retains a possible fallback for an absent or changed slot: %s",
    (setup) => {
      expect(
        analyzeJavaScriptStaticSource(`${SHIM}${setup}target.Q=other;${READ}`)
          .electron.browser_windows,
      ).toEqual([]);
    },
  );
});
