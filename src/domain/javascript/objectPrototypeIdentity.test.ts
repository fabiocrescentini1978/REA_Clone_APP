import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const LOAD =
  'new (require.call.call(require,null,"electron").BrowserWindow)({});';
const windows = (setup: string) =>
  analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows;

it.each([
  [
    'const p={["__proto__"]:Function.prototype};const o=Object.create(p);o.__proto__.call=other;',
    0,
  ],
  [
    'const p={["__proto__"]:{}};const o=Object.create(p);o.__proto__.call=other;',
    1,
  ],
  [
    "const p={get __proto__(){return Function.prototype}};const o=Object.create(p);o.__proto__.call=other;",
    0,
  ],
  [
    "const o=Object.create(Function.prototype);Object.getPrototypeOf(o).call=other;",
    0,
  ],
] as const)("retains factory prototype selection in %s", (setup, expected) => {
  expect(windows(setup)).toHaveLength(expected);
});

it.each(['Reflect.set(target,"extra",value,receiver);', "target.extra=value;"])(
  "retains unknown setter RHS mutation alternatives: %s",
  (store) => {
    expect(
      windows(
        `function U(){return unknown}const value=new U();const target={set extra(v){v.call=other}};const receiver={extra:{}};${store}`,
      ),
    ).toEqual([]);
  },
);

it.each([
  ["{}", '{["__proto__"]:{}}'],
  ["Function.prototype", '{["__proto__"]:{}}'],
  ["{}", "{__proto__:null}"],
  ["Function.prototype", "{__proto__:null}"],
])(
  "keeps Reflect.set lookup target %s separate from receiver %s",
  (target, receiver) => {
    expect(
      windows(
        `const target=${target};const receiver=${receiver};Reflect.set(target,"__proto__",Function.prototype,receiver);Object.getPrototypeOf(receiver).call.call=other;`,
      ),
    ).toEqual([]);
  },
);

it.each([
  'const target={};const receiver={["__proto__"]:{}};const alias=receiver;Reflect.set(target,"__proto__",Function.prototype,alias);Object.getPrototypeOf(receiver).call.call=other;',
  'const target={["__proto__"]:{}};const receiver={};Reflect.set(target,"__proto__",Function.prototype,receiver);receiver.__proto__.call.call=other;',
])("follows the selected Reflect.set recipient: %s", (setup) => {
  expect(windows(setup)).toEqual([]);
});

it.each([
  'const target={["__proto__"]:{}};const receiver={["__proto__"]:{}};Reflect.set(target,"__proto__",Function.prototype,receiver);const ref=Object.getPrototypeOf(receiver).call??{};ref.call=other;',
  'const target={["__proto__"]:{}};const receiver={__proto__:null};Reflect.set(target,"__proto__",Function.prototype,receiver);const ref=(Object.getPrototypeOf(receiver)??{call:{}}).call??{};ref.call=other;',
  'const value=Function.prototype.call;const target={x:{}};const receiver={x:{}};Reflect.set(target,"x",value,receiver);',
])(
  "keeps Reflect.set own data separate from physical prototype writes: %s",
  (setup) => {
    expect(windows(setup)).toHaveLength(1);
  },
);

it.each([
  'const value={call:{}};const target={set x(v){v.call=Function.prototype.call}};const receiver={x:{}};Reflect.set(target,"x",value,receiver);value.call.call=other;',
  'const target={set __proto__(v){v.call.call=other}};const receiver={["__proto__"]:{}};Reflect.set(target,"__proto__",Function.prototype,receiver);',
  'const target={set extra(v){v.call=other}};const receiver={extra:{}};Reflect.set(target,"extra",Function.prototype.call,receiver);',
  "const target={set extra(v){v.call=other}};target.extra=Function.prototype.call;",
])(
  "keeps a property-store target setter able to consume the RHS: %s",
  (setup) => {
    expect(windows(setup)).toEqual([]);
  },
);

it.each([
  'const receiver={};Reflect.set(receiver,"__proto__",Function.prototype);',
  'const target={};const receiver={["__proto__"]:{}};Reflect.set(target,"__proto__",Function.prototype,receiver);',
  'const target={extra:{}};const receiver={set extra(v){v.call=other}};Reflect.set(target,"extra",Function.prototype.call,receiver);',
  "function C(){this.__proto__=Function.prototype}new C();",
  'class C{constructor(){Reflect.set(this,"__proto__",Function.prototype)}}new C();',
])("excludes data and native setters from RHS consumption: %s", (setup) => {
  expect(windows(setup)).toHaveLength(1);
});

it.each([
  'const obj={};Object.defineProperties(obj,{["__proto__"]:{value:Function.prototype}});obj.__proto__.call.call=other;',
  'const obj={};Reflect.set(obj,"__proto__",Function.prototype);Object.getPrototypeOf(obj).call.call=other;',
  'const obj={};Object.assign(obj,{["__proto__"]:Function.prototype});Object.getPrototypeOf(obj).call.call=other;',
  "const holder={p:Function.prototype};const obj={};({p:obj.__proto__}=holder);obj.call.call=other;",
  'const obj={};Object.defineProperty(obj,"__proto__",{value:Function.prototype,writable:true,enumerable:true,configurable:true});const ref=obj.__proto__;ref.call.call=other;',
  'Object.defineProperty(Object.prototype,"__proto__",{value:{},writable:true});const obj={__proto__:Function.prototype};obj.__proto__={call:{}};obj.call.call=other;',
  'Object.defineProperty(Function.prototype,"__proto__",{value:{},writable:true});const obj={__proto__:Function.prototype};obj.__proto__={call:{}};obj.call.call=other;',
  'const proto=Object.prototype;const define=Object.defineProperty;define(proto,"__proto__",{value:{},writable:true});const obj={__proto__:Function.prototype};obj.__proto__={call:{}};obj.call.call=other;',
  "const obj={call:Function.prototype.call};Object.freeze(obj);obj.call={};obj.call.call=other;",
  "const ref={call:{}};const obj={set __proto__(value){value.call=Function.prototype.call},__proto__:null,get __proto__(){return {}}};obj.__proto__=ref;ref.call.call=other;",
  'const ref={slot:{}};const obj={set x(value){value.slot=require("module").prototype},get x(){return {}}};obj.x=ref;ref.slot.require=other;',
  'const ref={slot:{}};const proto={};Object.defineProperty(proto,"x",{set(value){value.slot=require("module").prototype}});const obj={__proto__:proto};obj.x=ref;ref.slot.require=other;',
  'const proto={set __proto__(value){this.slot=require("module").prototype}};const obj={__proto__:proto,slot:{}};obj.__proto__={};obj.slot.require=other;',
  "const proto={set __proto__(value){this.call=Function.prototype.call}};const obj={__proto__:proto,call:{}};obj.__proto__={};obj.call.call=other;",
  "const obj={call:{},set __proto__(value){this.call=Function.prototype.call}};obj.__proto__={};obj.call.call=other;",
  "const obj={__proto__:null};Object.preventExtensions(obj);obj.toString={call:{}};const copy={...obj};copy.toString.call.call=other;",
  "const obj={__proto__:null};Object.seal(obj);obj.toString={call:{}};const copy={...obj};copy.toString.call.call=other;",
  "const obj={__proto__:null};Object.freeze(obj);obj.toString={call:{}};const copy={...obj};copy.toString.call.call=other;",
  "const obj={__proto__:Function.prototype};Object.preventExtensions(obj);obj.toString={call:{}};obj.toString.call.call=other;",
  "const obj={__proto__:Function.prototype};Object.seal(obj);obj.toString={call:{}};obj.toString.call.call=other;",
  "const obj={__proto__:Function.prototype};Object.freeze(obj);obj.toString={call:{}};obj.toString.call.call=other;",
  'Object.defineProperty(Function.prototype,"toString",{writable:false});const obj={__proto__:Function.prototype};obj.toString={call:{}};obj.toString.call.call=other;',
  'Object.defineProperty(Object.prototype,"toString",{writable:false});const obj={__proto__:Object.prototype};obj.toString={call:{}};obj.toString.call.call=other;',
  'const holder={};holder.x={};Object.defineProperty(Function.prototype,"toString",{writable:false});const obj={__proto__:Function.prototype};obj.toString={call:{}};obj.toString.call.call=other;',
  "const obj={};obj.toString={call:{}};delete obj.toString;obj.toString.call.call=other;",
  'const obj={};Object.defineProperty(obj,"toString",{value:{call:{}},configurable:true});delete obj.toString;obj.toString.call.call=other;',
  'const obj={};obj.toString={call:{}};Reflect.deleteProperty(obj,"toString");obj.toString.call.call=other;',
  "const obj={};obj.toString={call:{}};delete obj.toString;const copy={...obj};copy.toString.call.call=other;",
  'const obj={};obj.toString={call:{}};Object.defineProperty(obj,"toString",{get(){return Function.prototype.call}});obj.toString.call.call=other;',
  "const obj={};obj.toString={call:{}};unknown(obj);obj.toString.call.call=other;",
  'const obj={call:Function.prototype.call};Object.defineProperty=()=>{};Object.defineProperty(obj,"call",{value:{}});obj.call.call=other;',
  "const obj={__proto__:Function.prototype};Object.setPrototypeOf=()=>{};Object.setPrototypeOf(obj,{call:{}});obj.call.call=other;",
  'const obj={};Object.defineProperty(obj,"call",{value:Function.prototype.call});obj.call={};obj.call.call=other;',
  "const obj={};Object.setPrototypeOf(obj,Function.prototype);const saved=Object.getPrototypeOf(obj);Object.setPrototypeOf(obj,{call:{}});saved.call.call=other;",
  "const proto={__proto__:null,call:Function.prototype.call};Object.setPrototypeOf(proto,{});const obj={__proto__:proto};obj.__proto__.call.call=other;",
  "const proto={__proto__:null,call:Function.prototype.call};Reflect.setPrototypeOf(proto,{});const obj={__proto__:proto};obj.__proto__.call.call=other;",
  "const obj={__proto__:null};Object.setPrototypeOf(obj,Function.prototype);obj.call.call=other;",
  "const obj={__proto__:null};Reflect.setPrototypeOf(obj,Function.prototype);Object.getPrototypeOf(obj).call.call=other;",
  'const obj={};Object.defineProperty(obj,"apply",{value:Function.prototype.call});obj.apply.call=other;',
  'const obj={__proto__:null};Object.defineProperty(obj,"__proto__",{value:Function.prototype});obj.__proto__.call.call=other;',
  'const obj={["__proto__"]:{}};delete obj.__proto__;obj.__proto__=Function.prototype;Object.getPrototypeOf(obj).call.call=other;',
  "class Derived extends Object{};const Bound=Derived.bind(null);Object.getPrototypeOf(Bound).prototype.toString.call.call=other;",
  "const obj={__proto__:Function.prototype};const saved=obj.__proto__;Object.setPrototypeOf(obj,null);saved.call.call=other;",
  "const obj={};obj.__proto__=Function.prototype;Object.getPrototypeOf(obj).call.call=other;",
  "const obj={__proto__:{}};obj.__proto__=Function.prototype;Object.getPrototypeOf(obj).call.call=other;",
  "const obj={__proto__:Function.prototype};obj.__proto__.call.call=other;",
  "const obj={__proto__:Object.prototype};obj.__proto__.toString.call.call=other;",
  "const obj={__proto__:Function.prototype};Object.getPrototypeOf(obj).call.call=other;",
  'const proto={__proto__:Function.prototype,["__proto__"]:{}};const obj={__proto__:proto};Object.getPrototypeOf(obj).call.call=other;',
  "const proto={__proto__:null,call:Function.prototype.call};const obj={__proto__:proto};Object.getPrototypeOf(obj).call.call=other;",
  'const proto={__proto__:null,["__proto__"]:Function.prototype};const obj={__proto__:proto};obj.__proto__.call.call=other;',
  "const obj={__proto__:null};const copy={...obj};copy.toString.call.call=other;",
  "const obj={__proto__:null};const {...copy}=obj;copy.toString.call.call=other;",
  "const holder={proto:null};holder.proto=42;const obj={__proto__:holder.proto};obj.toString.call.call=other;",
  "const obj={__proto__:Function.prototype};const {call}=obj;call.call=other;",
  "const obj={__proto__:null,call:Function.prototype.call};const copy={...obj};copy.call.call=other;",
  "const obj={__proto__:null,call:Function.prototype.call};const {...copy}=obj;copy.call.call=other;",
  "const obj={method(){}};const copy={...obj};copy.method.call.call=other;",
  "const obj={__proto__:Function.prototype};obj.call.call=other;",
  'const proto=Function.prototype;const obj={"__proto__":proto};obj.call.call=other;',
  "const obj={__proto__:{__proto__:Function.prototype}};obj.call.call=other;",
  'const obj={["__proto__"]:{}};obj.toString.call.call=other;',
  "const __proto__={};const obj={__proto__};obj.toString.call.call=other;",
  "const obj={__proto__(){}};obj.toString.call.call=other;",
  "const obj={get __proto__(){return {}}};obj.toString.call.call=other;",
  "const obj={set __proto__(value){}};obj.toString.call.call=other;",
  "const proto=42;const obj={__proto__:proto};obj.toString.call.call=other;",
  "const obj={__proto__:flag?null:42};obj.toString.call.call=other;",
  "const obj={__proto__:(()=>42)()};obj.toString.call.call=other;",
  "const obj={__proto__:42};obj.toString.call.call=other;",
  "const obj={__proto__:Function.prototype,call:{}};delete obj.call;obj.call.call=other;",
  'const obj={__proto__:Function.prototype,call:{}};Reflect.deleteProperty(obj,"call");obj.call.call=other;',
  "const obj={__proto__:Function.prototype,call:{}};unknown(obj);obj.call.call=other;",
])("follows object literal prototype value reads: %s", (setup) => {
  expect(windows(setup)).toEqual([]);
});

it.each([
  'const obj={["__proto__"]:{}};Reflect.set(obj,"__proto__",Function.prototype);const ref=Object.getPrototypeOf(obj).call??{};ref.call=other;',
  'const obj={["__proto__"]:{}};Object.assign(obj,{["__proto__"]:Function.prototype});const ref=Object.getPrototypeOf(obj).call??{};ref.call=other;',
  'const obj={__proto__:null};Object.defineProperties(obj,{["__proto__"]:{value:Function.prototype}});const ref=Object.getPrototypeOf(obj)??{call:{}};ref.call.call=other;',
  'const source={__proto__:{["__proto__"]:Function.prototype}};const obj={};Object.assign(obj,source);const ref=Object.getPrototypeOf(obj).call??{};ref.call=other;',
  "const obj={toString:{call:{}}};Object.freeze(obj);obj.toString.call.call=other;",
  "const obj={toString:{call:{}}};Object.seal(obj);obj.toString.call.call=other;",
  "const obj={toString:{call:{}}};Object.preventExtensions(obj);obj.toString.call.call=other;",
  'const obj={toString:{call:{}}};Object.defineProperty(obj,"call",{value:Function.prototype.call,enumerable:true,configurable:true});const copy={...obj};copy.toString.call.call=other;',
  "const obj={get toString(){return {call:{}}}};obj.toString={call:{}};obj.toString.call.call=other;",
  "const obj={};obj.__proto__=Function.prototype;obj.__proto__={call:{}};obj.call.call=other;",
  "const obj={call:{}};delete obj.call;const copy={...obj};const value=copy.call??{};value.call=other;",
  "const obj={call:{}};Object.freeze(obj);obj.call.call=other;",
  'const obj={call:{},["__proto__"]:{}};obj.__proto__=Function.prototype;obj.call.call=other;',
  'const obj={call:{}};Object.defineProperty(obj,"__proto__",{value:{},writable:false});obj.__proto__=Function.prototype;obj.call.call=other;',
  'Object.defineProperty(Function.prototype,"toString",{writable:true});const obj={__proto__:Function.prototype};obj.toString={call:{}};obj.toString.call.call=other;',
  'Object.defineProperty(Object.prototype,"toString",{writable:true});const obj={__proto__:Object.prototype};obj.toString={call:{}};obj.toString.call.call=other;',
  'const obj={__proto__:Function.prototype};obj.toString={call:{}};Object.defineProperty(Function.prototype,"toString",{writable:false});obj.toString.call.call=other;',
  "const obj={__proto__:null};obj.toString={call:{}};const copy={...obj};copy.toString.call.call=other;",
  "const obj={__proto__:null};obj.toString={call:{}};const {...copy}=obj;copy.toString.call.call=other;",
  "const obj={__proto__:Function.prototype};obj.toString={call:{}};obj.toString.call.call=other;",
  "const obj={__proto__:Function.prototype};obj.toString={call:{}};const copy={...obj};copy.toString.call.call=other;",
  "const obj={};obj.toString={call:{}};const copy={...obj};delete obj.toString;copy.toString.call.call=other;",
  'const obj={};Object.defineProperty(obj,"toString",{value:{call:{}},configurable:true,enumerable:true});const copy={...obj};delete obj.toString;copy.toString.call.call=other;',
  "const obj={__proto__:Function.prototype};Object.setPrototypeOf(obj,{call:{}});obj.call.call=other;",
  "const set=Object.setPrototypeOf;const obj={__proto__:Function.prototype};Object.setPrototypeOf=()=>{};set(obj,{call:{}});obj.call.call=other;",
  'const define=Object.defineProperty;const obj={call:Function.prototype.call};Object.defineProperty=()=>{};define(obj,"call",{value:{}});obj.call.call=other;',
  'const obj={};Object.defineProperty(obj,"call",{value:Function.prototype.call,writable:true});Object.defineProperty(obj,"call",{value:{}});obj.call.call=other;',
  "const obj={};Object.setPrototypeOf(obj,Function.prototype);Object.setPrototypeOf(obj,{call:{}});obj.call.call=other;",
  "const obj={};Object.setPrototypeOf(obj,Function.prototype);Object.setPrototypeOf(obj,{call:{}});Object.getPrototypeOf(obj).call.call=other;",
  'const obj={};Object.defineProperty(obj,"call",{value:Function.prototype.call,writable:true,configurable:true});obj.call={};obj.call.call=other;',
  'const obj={toString:{call:{}}};Object.defineProperty(obj,"x",{value:1});obj.toString.call.call=other;',
  'const obj={__proto__:null};Object.defineProperty(obj,"__proto__",{value:Function.prototype});Object.getPrototypeOf(obj).call.call=other;',
  'const obj={["__proto__"]:{}};obj.__proto__=Function.prototype;Object.getPrototypeOf(obj).call.call=other;',
  'const obj={["__proto__"]:{}};Object.setPrototypeOf(obj,Function.prototype);obj.__proto__.call.call=other;',
  "const obj={toString:{call:{}}};const a={...obj};delete obj.toString;const copy={...a};copy.toString.call.call=other;",
  "const obj={toString:{call:{}}};const arr=[obj];const {...copy}=arr[0];copy.toString.call.call=other;",
  "const obj={toString:{call:{}}};const get=()=>obj;const {...copy}=get();copy.toString.call.call=other;",
  "const obj={toString:{call:{}}};const {...copy}=flag?obj:obj;copy.toString.call.call=other;",
  "const obj={__proto__:null};obj.__proto__=Function.prototype;Object.getPrototypeOf(obj).call.call=other;",
  "const source={toString:{}};const copy={...source};copy.toString.call.call=other;",
  "const obj={__proto__:null,toString:{call:{}}};const {...a}=obj;const {...copy}=a;copy.toString.call.call=other;",
  "const proto=null;const holder={proto};const obj={__proto__:holder.proto};obj.toString.call.call=other;",
  'const proto={__proto__:Function.prototype,["__proto__"]:{}};const obj={__proto__:proto};obj.__proto__.call.call=other;',
  'const proto={__proto__:null,["__proto__"]:Function.prototype};const obj={__proto__:proto};Object.getPrototypeOf(obj).call.call=other;',
  "const proto={__proto__:null,call:Function.prototype.call};const obj={__proto__:proto};obj.__proto__.call.call=other;",
  "const obj={__proto__:Function.prototype,get __proto__(){return {}}};obj.__proto__.call.call=other;",
  "const obj={__proto__:Function.prototype};const copy={...obj};copy.call.call=other;",
  "const obj={__proto__:Function.prototype};const {...copy}=obj;copy.call.call=other;",
  "const obj={__proto__:{method(){}}};const copy={...obj};copy.method.call.call=other;",
  "const obj={__proto__:Function.prototype};const holder={obj};const {obj:{...copy}}=holder;copy.call.call=other;",
  "const obj={__proto__:Function.prototype};obj.call=other;",
  "const obj={__proto__:Function.prototype,call:{}};obj.call.call=other;",
  "const obj={__proto__:Function.prototype,call:{}};const saved=obj.call;delete obj.call;saved.call=other;",
  "const proto=null;const obj={__proto__:proto};obj.toString.call.call=other;",
  "const proto={toString:{}};const obj={__proto__:proto};obj.toString.call.call=other;",
  "const obj={__proto__:null};obj.toString.call.call=other;",
  'const obj={["__proto__"]:Function.prototype};obj.call.call=other;',
  "const __proto__=Function.prototype;const obj={__proto__};obj.call.call=other;",
])("keeps own property writes and null prototypes separate: %s", (setup) => {
  expect(windows(setup)).toHaveLength(1);
});
