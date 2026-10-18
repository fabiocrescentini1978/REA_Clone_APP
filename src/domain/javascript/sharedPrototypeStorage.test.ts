import { expect, it } from "vitest";

import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const LOAD =
  'new (require.call.call(require,null,"electron").BrowserWindow)({});';
const windows = (setup: string) =>
  analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows;

it.each([
  "Object.prototype.extra=Function.prototype.call;const obj={};obj.extra.call=other;",
  "const prototype=Object.prototype;prototype.extra=Function.prototype.call;const obj={};obj.extra.call=other;",
  "Object.prototype.extra={value:Function.prototype.call};const obj={};obj.extra.value.call=other;",
  "Object.prototype.extra=Function.prototype.call;const obj={};const saved=obj.extra;delete Object.prototype.extra;saved.call=other;",
  'Object.defineProperty(Object.prototype,"extra",{value:Function.prototype.call});const obj={};obj.extra.call=other;',
  'const descriptor={value:Function.prototype.call};Reflect.defineProperty(Object.prototype,"extra",descriptor);const obj={};obj.extra.call=other;',
  'Reflect.set(Object.prototype,"extra",Function.prototype.call);const obj={};obj.extra.call=other;',
  "Object.prototype.self=Object.prototype;Object.prototype.self.extra=Function.prototype.call;const obj={};obj.extra.call=other;",
  "Object.prototype.extra={};Object.prototype.extra.value=Function.prototype.call;const obj={};obj.extra.value.call=other;",
  'const descriptor={value:Function.prototype.call};Object.defineProperty(Object.prototype,"extra",descriptor);descriptor.value={};const obj={};obj.extra.call=other;',
  "Object.prototype.extra=Function.prototype.call;const obj=[];obj.extra.call=other;",
  "Object.setPrototypeOf(Function.prototype,{extra:Function.prototype.call});const obj=()=>{};obj.extra.call=0;",
  "Object.prototype.extra=Function.prototype.call;const obj=()=>{};obj.extra.call=other;",
  "Object.assign(Object.prototype,{extra:Function.prototype.call});const obj={};obj.extra.call=other;",
  "Object.defineProperties(Object.prototype,{extra:{value:Function.prototype.call}});const obj={};obj.extra.call=other;",
  "const values={extra:Function.prototype.call};Object.assign(Object.prototype,values);const obj={};obj.extra.call=other;",
  "Object.assign(Object.prototype,{extra:{nested:Function.prototype.call}});const obj={};obj.extra.nested.call=other;",
  "Object.defineProperties(Object.prototype,{extra:{value:{nested:Function.prototype.call}}});const obj={};obj.extra.nested.call=other;",
  "Object.assign(Object.prototype,{extra:{}});Object.prototype.extra.nested=Function.prototype.call;({}).extra.nested.call=0;",
  "const source={extra:{}};Object.assign(Object.prototype,source);source.extra.nested=Function.prototype.call;({}).extra.nested.call=0;",
  "const source={};source.extra=Function.prototype.call;Object.assign(Object.prototype,source);({}).extra.call=0;",
  "const child={};const source={extra:child};Object.assign(Object.prototype,source);source.extra={};child.nested=Function.prototype.call;({}).extra.nested.call=0;",
  "Object.defineProperties(Object.prototype,{extra:{value:{}}});Object.prototype.extra.nested=Function.prototype.call;({}).extra.nested.call=0;",
  "const native=Object.prototype;globalThis.Object={prototype:{}};native.extra=Function.prototype.call;({}).extra.call=0;",
  'Object.defineProperty(globalThis,"Object",{writable:false});Object={prototype:{}};Object.prototype.extra=Function.prototype.call;({}).extra.call=0;',
  "unknown();Object={prototype:{}};Object.prototype.extra=Function.prototype.call;({}).extra.call=0;",
  'Object.defineProperty(globalThis,"Object",{set(value){}});Object={prototype:{}};const native={}.constructor.prototype;native.extra=Function.prototype.call;({}).extra.call=0;',
  "const native=Object.prototype;let fake={prototype:native};Object=fake;fake={prototype:{}};Object.prototype.extra=Function.prototype.call;({}).extra.call=0;",
  "Object={...input,prototype:{}};Object.prototype.extra=Function.prototype.call;({}).extra.call=0;",
  'Object.defineProperty(Object.prototype,"extra",{get(){return Function.prototype.call}});({}).extra.call=0;',
  "Object.defineProperties(Object.prototype,{extra:{get(){return Function.prototype.call}}});({}).extra.call=0;",
  'Object.prototype.__defineGetter__("extra",()=>Function.prototype.call);({}).extra.call=0;',
  'Object.defineProperty(Object.prototype,"extra",{get(){return this.target}});({target:Function.prototype.call}).extra.call=0;',
  'Object.defineProperty(Object.prototype,"extra",{get(){return input}});({}).extra.call=0;',
  "Object.assign(Object.prototype,{get extra(){return Function.prototype.call}});({}).extra.call=0;",
  'Object.prototype.get=()=>Function.prototype.call;Object.defineProperty(Object.prototype,"extra",{});({}).extra.call=0;',
  'const descriptor={get:()=>({})};descriptor.get=()=>Function.prototype.call;Object.defineProperty(Object.prototype,"extra",descriptor);({}).extra.call=0;',
  'const getter=flag?()=>({}):input;Object.defineProperty(Object.prototype,"extra",{get:getter});({}).extra.call=0;',
])("follows source stores in shared prototype slots: %s", (setup) => {
  expect(windows(setup)).toEqual([]);
});

it.each([
  "Object.prototype.extra={};const obj={};const saved=obj.extra;Object.prototype.extra=Function.prototype.call;saved.call=other;",
  "Object.prototype.extra=Function.prototype.call;const obj={extra:{}};obj.extra.call=other;",
  "Object.prototype.extra=Function.prototype.call;const obj={};obj.extra=other;",
  "const prototype={};prototype.extra=Function.prototype.call;const obj={};obj.extra.call=other;",
  'Reflect.set({},"extra",Function.prototype.call);const obj={};obj.extra.call=other;',
  'const obj={};const saved=obj.extra??{};Object.defineProperty(Object.prototype,"extra",{value:Function.prototype.call});saved.call=other;',
  'const descriptor={value:{}};Object.defineProperty(Object.prototype,"extra",descriptor);descriptor.value=Function.prototype.call;const obj={};obj.extra.call=other;',
  'Reflect.set(Object.prototype,"extra",Function.prototype.call,{});const obj={};obj.extra.call=other;',
  "Object.assign(Object.prototype,{unrelated:Function.prototype.call});const obj={};obj.extra.call=other;",
  "Object.defineProperties(Object.prototype,{unrelated:{value:Function.prototype.call}});const obj={};obj.extra.call=other;",
  "const source={__proto__:{extra:Function.prototype.call}};Object.assign(Object.prototype,source);const obj={};obj.extra.call=other;",
  "Object.prototype.extra={};const saved={}.extra;Object.assign(Object.prototype,{extra:Function.prototype.call});saved.call=other;",
  "const fake={prototype:{}};globalThis.Object=fake;Object.prototype.extra=Function.prototype.call;const saved=({}).extra??{};saved.call=other;",
  "const fake={prototype:{}};Object=fake;Object.prototype.extra=Function.prototype.call;const saved=({}).extra??{};saved.call=other;",
  "const native=Object.prototype;Object={prototype:{}};Object.prototype.extra=Function.prototype.call;const saved=native.extra??{};saved.call=other;",
  "var Object={prototype:{}};Object.prototype.extra=Function.prototype.call;const saved=({}).extra??{};saved.call=other;",
  'Object.defineProperty(Object.prototype,"extra",{get(){return {}}});({}).extra.call=0;',
  'var local={};Object.defineProperty(Object.prototype,"extra",{get(){return local}});({}).extra.call=0;',
  "Object.defineProperties(Object.prototype,{extra:{get(){return {}}}});({}).extra.call=0;",
  'Object.prototype.__defineGetter__("extra",()=>({}));({}).extra.call=0;',
  'Object.prototype.__defineSetter__("extra",()=>Function.prototype.call);const saved=({}).extra??{};saved.call=0;',
])(
  "keeps captures and local owners separate from shared stores: %s",
  (setup) => {
    expect(windows(setup)).toHaveLength(1);
  },
);

it.each([
  {
    name: "native bulk stores",
    make: (index: number) =>
      `Object.assign(Object.prototype,{k${index}:Function.prototype.call});({}).k${index}.call=other;`,
    expected: 0,
  },
  {
    name: "native getter stores",
    make: (index: number) =>
      `Object.defineProperty(Object.prototype,'k${index}',{get(){return {call:{}}},configurable:true});({}).k${index}.call.call=other;`,
    expected: 1,
  },
])("resolves repeated $name", ({ make, expected }) => {
  const setup = Array.from({ length: 300 }, (_, index) => make(index)).join("");
  expect(windows(setup)).toHaveLength(expected);
});

it("keeps the CommonJS wrapper require separate from the global require slot", () => {
  const source = `globalThis.require={extra:Function.prototype.call};const saved=require.extra??{};saved.call=other;${LOAD}`;
  const parsed = parseJavaScriptSource(source, "app.cjs");
  if (parsed === null) throw new Error("Expected parsed CommonJS source");
  expect(
    analyzeParsedJavaScriptStaticSource(source, parsed).electron
      .browser_windows,
  ).toHaveLength(1);
});
