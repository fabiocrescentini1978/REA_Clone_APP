import * as t from "@babel/types";
import { describe, expect, it, vi } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  createSemanticPrecedingEffectIndex,
  semanticEffectFollowsInitialCapture,
  semanticEffectTiming,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const parentMap = (program: t.Program): WeakMap<t.Node, t.Node> => {
  const parents = new WeakMap<t.Node, t.Node>();
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      if (parent !== null) parents.set(node, parent);
    },
  });
  return parents;
};

describe("preceding effect timing index", () => {
  it("skips later sibling batches without pairwise timing queries", () => {
    const count = 400;
    const reads = Array.from({ length: count }, () =>
      t.callExpression(t.identifier("read"), []),
    );
    const writes = Array.from({ length: count }, () =>
      t.callExpression(t.identifier("write"), []),
    );
    const parents = parentMap(
      t.program([...reads, ...writes].map(t.expressionStatement)),
    );
    const follows = vi.fn((capture: t.Node, effect: t.Node | undefined) =>
      semanticTopLevelEffectFollowsCapture(capture, effect, parents),
    );
    const index = createSemanticPrecedingEffectIndex(parents, follows);
    for (const node of writes) index.add({ node });
    for (const read of reads) expect(index.mayPrecede(read)).toBe(false);
    expect(follows.mock.calls.length).toBeLessThanOrEqual(count * 2);
  });

  it("retires and replaces sibling effects without revisiting retired batches", () => {
    const count = 400;
    const calls = Array.from({ length: count }, () =>
      t.callExpression(t.identifier("call"), []),
    );
    const parents = parentMap(t.program(calls.map(t.expressionStatement)));
    const follows = vi.fn(
      (capture: t.Node, effect: t.Node | undefined) =>
        capture === effect ||
        semanticTopLevelEffectFollowsCapture(capture, effect, parents),
    );
    const index = createSemanticPrecedingEffectIndex(parents, follows);
    const effects = calls.map((node) => ({ node }));
    for (const effect of effects) index.add(effect);
    for (const effect of effects) {
      expect(index.mayPrecede(effect.node)).toBe(false);
      index.delete(effect);
      const replacement = { node: effect.node };
      index.add(replacement);
      expect(index.mayPrecede(effect.node)).toBe(false);
      index.delete(replacement);
    }
    expect(follows.mock.calls.length).toBeLessThanOrEqual(count * 3);
    index.add(effects[0]!);
    expect(index.mayPrecede(calls.at(-1)!)).toBe(true);
    index.delete(effects[0]!);
    expect(index.mayPrecede(calls.at(-1)!)).toBe(false);
  });

  it("keeps positions scoped to each immutable parent map", () => {
    const read = t.expressionStatement(
      t.callExpression(t.identifier("read"), []),
    );
    const write = t.expressionStatement(
      t.callExpression(t.identifier("write"), []),
    );
    for (const [body, precedes] of [
      [[read, write], false],
      [[write, read], true],
    ] as const) {
      const parents = parentMap(t.program([...body]));
      const index = createSemanticPrecedingEffectIndex(
        parents,
        (capture, effect) =>
          semanticTopLevelEffectFollowsCapture(capture, effect, parents),
      );
      index.add({ node: write.expression });
      expect(index.mayPrecede(read.expression)).toBe(precedes);
    }
  });

  it("retires individual effects without discarding a receiver at the same call", () => {
    const call = t.expressionStatement(
      t.callExpression(t.identifier("call"), []),
    );
    const read = t.expressionStatement(
      t.callExpression(t.identifier("read"), []),
    );
    const parents = parentMap(t.program([call, read]));
    const index = createSemanticPrecedingEffectIndex(
      parents,
      (capture, effect) =>
        semanticTopLevelEffectFollowsCapture(capture, effect, parents),
    );
    const argument = { node: call.expression };
    const receiver = { node: call.expression };
    index.add(argument);
    index.add(receiver);
    index.delete(argument);
    expect(index.mayPrecede(read.expression)).toBe(true);
    index.delete(receiver);
    expect(index.mayPrecede(read.expression)).toBe(false);
    const unknown = { node: undefined };
    index.add(unknown);
    expect(index.mayPrecede(read.expression)).toBe(true);
    index.delete(unknown);
    expect(index.mayPrecede(read.expression)).toBe(false);
  });

  it.each([
    "first();second();",
    "first(),second();",
    "first(second());",
    "const a=first(),b=second();",
    "first();function deferred(){second()}",
    "function deferred(){first();second()}",
    "first();for(let i=0;i<2;i++)second();",
    "for(const item of [])first();second();",
    "first();class C{field=second()}",
    "first();class C{static field=second()}",
    "if(flag){first()}second();",
  ])("preserves canonical fallback timing for %s", (source) => {
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected parsed source");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    const calls: t.CallExpression[] = [];
    traverseJavaScriptAst(parsed.program, {
      enter: (node) => {
        if (t.isCallExpression(node)) calls.push(node);
      },
    });
    const effects = calls.map((node) => ({ node }));
    for (const follows of [
      (capture: t.Node, effect: t.Node | undefined) =>
        semanticEffectTiming(capture, effect, state) === "after",
      (capture: t.Node, effect: t.Node | undefined) =>
        semanticEffectFollowsInitialCapture(capture, effect, state),
    ]) {
      const index = createSemanticPrecedingEffectIndex(
        state.parentsByNode,
        follows,
      );
      for (const effect of effects) index.add(effect);
      for (const call of calls)
        expect(index.mayPrecede(call)).toBe(
          effects.some(({ node }) => !follows(call, node)),
        );
      for (const effect of effects) {
        index.delete(effect);
        const remaining = effects.slice(effects.indexOf(effect) + 1);
        for (const call of calls)
          expect(index.mayPrecede(call)).toBe(
            remaining.some(({ node }) => !follows(call, node)),
          );
      }
    }
  });
});
