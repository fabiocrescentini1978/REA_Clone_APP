import { expect, it } from "vitest";
import * as t from "@babel/types";

import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { isUnmodifiedImportMetaUrl } from "./javascriptSemanticAmbientWrites.js";

const LOAD =
  'new (require.call.call(require,null,"electron").BrowserWindow)({});';
const windows = (setup: string) =>
  analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows;

it.each([
  [
    "Object.create=()=>({constructor:Function.prototype.call});",
    "Object.create(null)",
    0,
  ],
  [
    "const make=Object.create;Object.create=()=>({constructor:Function.prototype.call});",
    "make(null)",
    1,
  ],
  [
    "Object.create=()=>({constructor:Function.prototype.call});const make=Object.create;",
    "make(null)",
    0,
  ],
  [
    "const make=Object.create.bind(null,null);Object.create=()=>({constructor:Function.prototype.call});",
    "make()",
    1,
  ],
  [
    "Object.create=()=>({constructor:Function.prototype.call});const make=Object.create.bind(null,null);",
    "make()",
    0,
  ],
  ["", "Object.create(null)", 1],
] as const)(
  "captures Object.create integrity for allocated prototypes: %s %s",
  (setup, creation, count) => {
    expect(
      windows(
        `${setup}function C(){this.constructor.call=other}C.prototype=${creation};new C();`,
      ),
    ).toHaveLength(count);
  },
);

it.each([
  ["Object.create=()=>({constructor:M});", "Object.create(null)", 0],
  [
    "const make=Object.create;Object.create=()=>({constructor:M});",
    "make(null)",
    1,
  ],
  [
    "Object.create=()=>({constructor:M});const make=Object.create;",
    "make(null)",
    0,
  ],
  [
    "const make=Object.create.bind(null,null);Object.create=()=>({constructor:M});",
    "make()",
    1,
  ],
  [
    "Object.create=()=>({constructor:M});const make=Object.create.bind(null,null);",
    "make()",
    0,
  ],
  ["", "Object.create(null)", 1],
] as const)(
  "checks prototype factory integrity across nominal Module owners: %s %s",
  (setup, creation, count) => {
    const source = `const M=require('module');${setup}function C(){this.constructor._load=other}C.prototype=${creation};new C();new(module.require('electron').BrowserWindow)({});`;
    expect(
      analyzeJavaScriptStaticSource(source).electron.browser_windows,
    ).toHaveLength(count);
  },
);

it("keeps an allocated native null prototype after its factory is replaced", () => {
  expect(
    windows(
      "function C(){this.constructor.call=other}C.prototype=Object.create(null);Object.create=()=>({constructor:Function.prototype.call});new C();",
    ),
  ).toHaveLength(1);
});

it.each([
  "function C(){this.constructor.call.call=other}new C();",
  "class C{constructor(){this.constructor.call.call=other}}new C();",
  "class C{field=(this.constructor.call.call=other)}new C();",
  "function C(){this.constructor={call:{}};this.constructor.call.call=other}Object.defineProperty(C.prototype,'constructor',{get(){return Function.prototype.call},set(v){}});new C();",
  "function C(){this.constructor={call:{}};this.constructor.call.call=other}unknown(C.prototype);new C();",
  "function C(){this.__proto__.__proto__.toString.call.call=other}new C();",
  "function C(){this.constructor.call.call=other;return globalThis}new C();",
  "class B{constructor(){this.constructor.call.call=other}}class C extends B{}new C();",
  "class B{}class C extends B{field=(this.constructor.call.call=other)}new C();",
  "class B{field=(this.constructor.call.call=other)}class C extends B{}new C();",
  "function C(){this.constructor.call.call=other}Reflect.construct(C,[]);",
  "function C(){this.constructor.call.call=other}const make=Reflect.construct;make(C,[]);",
  "function C(){this.constructor.call.call=other}function N(){}Reflect.construct(C,[],N);",
  "function C(){this.constructor=Function.prototype.call;this.constructor.call=other}new C();",
  "function C(){this.extra=Function.prototype.call;this.extra.call=other}new C();",
  "class C{extra=Function.prototype.call;field=(this.extra.call=other)}new C();",
  "function C(){N.prototype={constructor:{call:{}}};this.constructor.call.call=other}function N(){}Reflect.construct(C,[],N);",
  "function C(){this.constructor={call:{}};delete this.constructor;this.constructor.call.call=other}new C();",
  "function C(){this.constructor={call:{}};unknown(this);this.constructor.call.call=other}new C();",
  "var B=class{['constructor']={call:{}}};globalThis.B=class{};class C extends B{field=(this.constructor.call.call=other)}new C();",
  "function C(){this.__proto__.call=other}function N(){}N.prototype={['__proto__']:Function.prototype.call};Reflect.construct(C,[],N);",
  "function C(){this.extra.call=other}C.prototype.extra=Function.prototype.call;new C();",
  "function C(){this.constructor.call=other}C.prototype.constructor=Function.prototype.call;new C();",
  "function C(){if(this.extra)this.extra.call=other;C.prototype={extra:Function.prototype.call}}new C();new C();",
  "function C(){if(this.extra)this.extra.call=other;N.prototype={extra:Function.prototype.call}}function N(){}Reflect.construct(C,[],N);Reflect.construct(C,[],N);",
  "function N(){}class C{static{N.prototype={extra:Function.prototype.call}}constructor(){this.extra.call=other}}Reflect.construct(C,[],N);",
  "let f;function C(){this.extra={};f=()=>this.extra.call=other}const c=new C();c.extra=Function.prototype.call;f();",
  "function C(){this.constructor.assign.call.call=other}C.prototype=null;new C();",
  "function N(){}class C{field=(N.prototype={extra:Function.prototype.call});later=(this.extra.call=other)}unknown(C);Reflect.construct(C,[],N);",
  "function N(){}class C{field=(N.prototype={extra:Function.prototype.call});later=(this.extra.call=other)}unknown({C});Reflect.construct(C,[],N);",
  "function C(){this.constructor.call.call=other}function N(){}Object.defineProperty(N,'prototype',{writable:false});N.prototype={constructor:{call:{}}};Reflect.construct(C,[],N);",
  "function C(){Object.getPrototypeOf(this).constructor.call.call=other}new C();",
  "class C{['__proto__']={constructor:{call:{}}};field=(Object.getPrototypeOf(this).constructor.call.call=other)}new C();",
])("tracks shared values reached from allocated receivers: %s", (setup) => {
  expect(windows(setup)).toEqual([]);
});

it.each([
  "function C(){this.constructor.call=other;return globalThis}new C();",
  "function C(){this.__proto__.call=other}new C();",
  "function C(){this.call=other}new C();",
  "function C(){this.constructor={call:{}};this.constructor.call.call=other}new C();",
  "class C{constructor(){this.constructor={call:{}};this.constructor.call.call=other}}new C();",
  "class C{['constructor']={call:{}};field=(this.constructor.call.call=other)}new C();",
  "class B{constructor(){return {constructor:{call:{}}}}}class C extends B{field=(this.constructor.call.call=other)}new C();",
  "function B(){return {constructor:{call:{}}}}class C extends B{field=(this.constructor.call.call=other)}new C();",
  "function C(){this.constructor.call.call=other}function N(){}N.prototype=Object.create(null);Reflect.construct(C,[],N);",
  "function C(){this.constructor.assign.call.call=other}C.prototype=Object.create(null);new C();",
  "function C(){this.__proto__.__proto__.toString.call.call=other}class N extends null{}Reflect.construct(C,[],N);",
  "class C{['__proto__']={constructor:{call:{}}};field=(this.__proto__.constructor.call.call=other)}new C();",
  "let f;function C(){this.constructor={call:{}};f=()=>this.constructor.call.call=other;return {}}const c=new C();c.constructor=Function;f();",
])(
  "keeps local allocated slots and supplied receivers separate: %s",
  (setup) => {
    expect(windows(setup)).toHaveLength(1);
  },
);

it("keeps a returned global object separate from its constructor's this", () => {
  const source =
    'var Q=(e=>typeof require<"u"?require:e)(function(){});function C(){this.Q=other;return globalThis}new C();Q("electron").ipcRenderer.send("kept");';
  expect(analyzeJavaScriptStaticSource(source).electron.ipc).toHaveLength(1);
});

it.each([
  // A distinct newTarget escapes through construction; its prototype's own
  // descriptors cannot currently establish a complete lifetime proof.
  "function C(){this.constructor.call.call=other}function N(){}N.prototype={constructor:{call:{}}};Reflect.construct(C,[],N);",
  "function C(){this.constructor.call.call=other}const N=C.bind(null);Reflect.construct(C,[],N);",
  "function C(){this.constructor.call.call=other}const N=C.bind(null);N.prototype={constructor:{call:{}}};Reflect.construct(C,[],N);",
  "function C(){this.constructor.call.call=other}const N=C.bind(null);Object.defineProperty(N,'prototype',{get(){return {constructor:{call:{}}}}});Reflect.construct(C,[],N);",
  "function C(){this.constructor.call.call=other}function N(){}function wrap(){return N}Reflect.construct(C,[],wrap());",
])("keeps unsupported newTarget inherited values uncertain: %s", (setup) => {
  expect(windows(setup)).toEqual([]);
});

it("still selects a proven own field before an unsupported newTarget prototype", () => {
  expect(
    windows(
      "class C{['constructor']={call:{}};field=(this.constructor.call.call=other)}const N=C.bind(null);Reflect.construct(C,[],N);",
    ),
  ).toHaveLength(1);
});

it.each([
  "class C extends unknown{constructor(){super();this.call=other}}new C();",
  "class C extends unknown{field=(this.call=other)}new C();",
  "function B(){return unknown}class C extends B{constructor(){super();this.call=other}}new C();",
  "function B(){return unknown}class C extends B{field=(this.call=other)}new C();",
  "function C(){return unknown}const c=new C();c.call=other;",
  "function B(){return new unknown}class C extends B{constructor(){super();this.call=other}}new C();",
  "function B(){return new unknown}class C extends B{field=(this.call=other)}new C();",
  "function C(){return new unknown}const c=new C();c.call=other;",
  "class B{constructor(){return new unknown}}class C extends B{field=(this.call=other)}new C();",
  "class C{constructor(){return new unknown}}const c=new C();c.call=other;",
  "var local={};globalThis.local=Function.prototype.call;class B{constructor(){return local}}class C extends B{field=(this.call=other)}new C();",
])(
  "keeps unknown supplied or returned receiver values uncertain: %s",
  (setup) => {
    expect(windows(setup)).toEqual([]);
  },
);

it.each([
  ["Object.create(module.constructor)", 0],
  ["Object.create(null)", 1],
] as const)(
  "keeps unsupported captured prototypes uncertain across nominal owners: %s",
  (prototype, count) => {
    const setup = `function C(){const p=Object.getPrototypeOf(Object.getPrototypeOf(this));if(p)p._load=other}C.prototype=${prototype};new C();`;
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}new(module.require('electron').BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(count);
  },
);

it.each([
  "class C extends unknown{constructor(){super();this.Q=other}}new C();",
  "class C extends unknown{field=(this.Q=other)}new C();",
])("allows unknown super results to reach ambient objects: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `var Q=(e=>typeof require<'u'?require:e)(function(){});${setup}Q('electron').ipcRenderer.send('changed');`,
    ).electron.ipc,
  ).toEqual([]);
});

it.each([
  "class B{}class C extends B{constructor(){super();this.call=other}}new C();",
  "class B{}class C extends B{field=(this.call=other)}new C();",
  "function B(){return this}class C extends B{field=(this.call=other)}new C();",
  "function B(){return null}class C extends B{field=(this.call=other)}new C();",
  "function C(){this.call=other;return unknown}new C();",
])("preserves proven allocated receiver own writes: %s", (setup) => {
  expect(windows(setup)).toHaveLength(1);
});

it.each([
  "class C extends unknown{field=(this.require=other)}new C();",
  "class C extends unknown{field=(this._load=other)}new C();",
])(
  "unknown receiver alternatives include CommonJS nominal objects: %s",
  (setup) => {
    const source = `${setup}new(module.require('electron').BrowserWindow)({});`;
    for (const path of ["bundle.js", "bundle.cjs"]) {
      const parsed = parseJavaScriptSource(source, path);
      if (parsed === null)
        throw new Error("Expected parsed constructor source");
      expect(
        analyzeParsedJavaScriptStaticSource(source, parsed).electron
          .browser_windows,
      ).toEqual([]);
    }
  },
);

it("unknown receiver alternatives invalidate a saved CommonJS delegate", () => {
  expect(
    windows(
      "const load=module.require.bind(module);class C extends unknown{field=(this._load=other)}new C();new(load('electron').BrowserWindow)({});",
    ),
  ).toEqual([]);
});

it.each([
  ["class C extends unknown{field=(this.url=other)}new C();", false],
  ["class C{field=(this.url=other)}new C();", true],
] as const)(
  "keeps unknown reference coverage terminal for import.meta: %s",
  (setup, intact) => {
    const parsed = parseJavaScriptSource(
      `${setup}import.meta.url;`,
      "bundle.mjs",
    );
    if (parsed === null) throw new Error("Expected parsed import.meta source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    completeSemanticSteps(index.indexAmbientWritesSteps());
    const statement = parsed.program.body.at(-1);
    if (!t.isExpressionStatement(statement))
      throw new Error("Expected import.meta expression");
    expect(
      isUnmodifiedImportMetaUrl(statement.expression, index.bindings),
    ).toBe(intact);
  },
);
