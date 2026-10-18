import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  createSemanticCallableTargets,
  createSemanticClassConstructionStages,
  createSemanticFunctionValueReferences,
  createSemanticFunctionValueCapture,
  createSemanticPrivateMemberTargets,
  createSemanticReturnedReferences,
  semanticConstructorKeepsReceiver,
  createSemanticUnknownCallableResults,
} from "./javascriptSemanticReturnedReferences.js";
import {
  semanticAmbientOwnSlotUnchanged,
  semanticAmbientIdentitySourcesReady,
  semanticAmbientOwnSlotFactsReady,
} from "./javascriptSemanticAmbientWrites.js";
import {
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
  semanticStrictContext,
  type SemanticGlobalBindingFacts,
} from "./javascriptSemanticOpaqueEffects.js";
import { semanticReferenceSourcesInactive } from "./javascriptSemanticReferenceSources.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";

import {
  semanticAllocatedReceiverIdentity,
  type SemanticAllocatedReceiverIdentity,
} from "./javascriptSemanticStorageIdentities.js";

export interface SemanticConstructedReceiver {
  readonly identity: SemanticAllocatedReceiverIdentity;
  readonly allocation: t.Node;
  readonly prototypeSource: t.Node;
  readonly prototypeSourceLocal: boolean;
  readonly target: t.Function | t.Class;
  readonly activations: readonly t.Node[];
  readonly fields: readonly {
    readonly key: string | null;
    readonly node: t.Node;
    readonly value: t.Node | null;
    readonly own: boolean;
  }[];
}

/** The supplied object may be any local or shared reference. This is mutation
 * possibility evidence, never a strict identity or an allocated heap key. */
export interface SemanticUnknownConstructorReceiver {
  readonly kind: "unknown-constructor-receiver";
  readonly allocation: t.Node;
  readonly source: t.Function | t.Class;
}

type ReceiverQuery = ((node: t.ThisExpression) => readonly t.Node[]) & {
  constructed(node: t.ThisExpression): readonly SemanticConstructedReceiver[];
  unknown(
    node: t.ThisExpression,
  ): readonly SemanticUnknownConstructorReceiver[];
  completion(node: t.Node):
    | {
        readonly receivers: readonly SemanticConstructedReceiver[];
        readonly unknown: readonly SemanticUnknownConstructorReceiver[];
        readonly sources: readonly (t.Function | t.Class)[];
        readonly complete: boolean;
      }
    | undefined;
  allocatedBefore(
    receiver: SemanticConstructedReceiver,
    mutation: t.Node,
  ): boolean;
};

/** Expressions that can supply a receiver; the Program denotes the global object. */
const receiverQueries = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ReceiverQuery
>();

type ReceiverSite = readonly [node: t.Node, parent: t.Node | null];
const receiverSites = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly ReceiverSite[]
>();

/** Retain syntax once per source; each proof snapshot selects uses afresh. */
const parsedReceiverSites = (
  state: JavaScriptSemanticAnalysisState,
): readonly ReceiverSite[] => {
  const prior = receiverSites.get(state);
  if (prior !== undefined) return prior;
  const sites: ReceiverSite[] = [];
  traverseJavaScriptAst(state.program, {
    enter: (node, parent) => {
      sites.push([node, parent]);
    },
  });
  receiverSites.set(state, sites);
  return sites;
};

/** Possible receiver identity is shared by all ambient-write consumers. */
export const createSemanticReceiverReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
  intrinsicWriteFacts?: SemanticGlobalBindingFacts,
) => {
  const customContext =
    isDefinitelyObject !== undefined || intrinsicWriteFacts !== undefined;
  const prior = customContext ? undefined : receiverQueries.get(state);
  if (prior !== undefined) return prior;
  const owners = new WeakMap<t.Node, t.Node>();
  const lexicalOwner = (node: t.Node): t.Node => {
    const visited: t.Node[] = [];
    let current = node;
    let owner: t.Node = state.program;
    for (;;) {
      const cached = owners.get(current);
      if (cached !== undefined) {
        owner = cached;
        break;
      }
      visited.push(current);
      let parent = state.parentsByNode.get(current);
      if (parent === undefined) break;
      // Parameter decorators can sit below patterns and TSParameterProperty.
      // Their expressions execute outside the decorated function or class.
      if (t.isDecorator(current)) {
        while (
          parent !== undefined &&
          !t.isFunction(parent) &&
          !t.isClass(parent) &&
          !t.isClassProperty(parent) &&
          !t.isClassPrivateProperty(parent) &&
          !t.isClassAccessorProperty(parent)
        )
          parent = state.parentsByNode.get(parent);
        current = parent ?? state.program;
        continue;
      }
      if (
        (t.isFunction(parent) &&
          !t.isArrowFunctionExpression(parent) &&
          !(
            (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
            parent.computed &&
            parent.key === current
          )) ||
        t.isStaticBlock(parent) ||
        ((t.isClassProperty(parent) ||
          t.isClassPrivateProperty(parent) ||
          t.isClassAccessorProperty(parent)) &&
          parent.value === current)
      ) {
        owner = parent;
        break;
      }
      current = parent;
    }
    for (const visitedNode of visited) owners.set(visitedNode, owner);
    return owner;
  };
  let receivers: WeakMap<t.Function, Set<t.Node>> | undefined;
  let constructed = new WeakMap<t.Node, SemanticConstructedReceiver[]>();
  let unknownReceivers = new WeakMap<
    t.Node,
    SemanticUnknownConstructorReceiver[]
  >();
  let completions = new WeakMap<
    t.Node,
    {
      receivers: SemanticConstructedReceiver[];
      unknown: SemanticUnknownConstructorReceiver[];
      sources: (t.Function | t.Class)[];
      complete: boolean;
    }
  >();
  let activationSites = new WeakMap<t.Node, Set<t.Node>>();
  let unknownActivations = new WeakSet<t.Node>();
  let factsReady = semanticFreshObjectFactsReady(state);
  let capturesReady = semanticAmbientIdentitySourcesReady(state);
  let ownSlotFactsReady = semanticAmbientOwnSlotFactsReady(state);
  const indexReceivers = () => {
    const indexed = new WeakMap<t.Function, Set<t.Node>>();
    receivers = indexed;
    constructed = new WeakMap();
    unknownReceivers = new WeakMap();
    completions = new WeakMap();
    activationSites = new WeakMap();
    unknownActivations = new WeakSet();
    const targets = createSemanticCallableTargets(
      state,
      "callable",
      isDefinitelyObject,
    );
    const contents = createSemanticCallableTargets(
      state,
      "contents",
      isDefinitelyObject,
    );
    const inactiveDefaults = new WeakSet<t.Node>();
    const defaultSources = new Map<
      t.AssignmentPattern,
      Set<JavaScriptSemanticInitializer>
    >();
    for (const binding of state.bindingsById.values())
      for (const reference of binding.referenceInitializers)
        for (const source of reference.fallbackSources ?? []) {
          if (source.selection === undefined) continue;
          const sources = defaultSources.get(source.selection) ?? new Set();
          sources.add(source);
          defaultSources.set(source.selection, sources);
        }
    // Nested patterns can select from the original input or an outer default.
    // The expression is inactive only when every retained input excludes it.
    for (const [selection, sources] of defaultSources)
      if (
        [...sources].every((source) =>
          semanticReferenceSourcesInactive(
            { fallbackSources: [source] },
            state,
            "syntax-only",
          ),
        )
      )
        inactiveDefaults.add(selection.right);
    const intrinsics = createSemanticModuleInterop(state);
    const definiteObject = isDefinitelyObject ?? intrinsics.isDefinitelyObject;
    const constructorValues = createSemanticFunctionValueReferences(state);
    // Before the ambient snapshot exists these are possible source receivers,
    // not binding-integrity proofs. Incomplete global binding facts must not
    // turn a source declaration into a permanent unknown mutation of itself.
    // The completed/custom query below rechecks its captured global identity.
    const sourceObjects =
      !customContext && !semanticFreshObjectFactsReady(state)
        ? createSemanticModuleInterop(state, {
            bindingReadMayHaveChanged: (binding, read) =>
              semanticOpaqueBindingReadMayHaveChanged(binding, read, state),
          })
        : intrinsics;
    const receiverObjects =
      intrinsicWriteFacts === undefined
        ? sourceObjects
        : createSemanticModuleInterop(state, {
            intrinsicPath: intrinsics.intrinsicPath,
            intrinsicWriteFacts,
            bindingReadMayHaveChanged: (binding, read) =>
              semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
              semanticGlobalBindingReadMayHaveChanged(
                binding,
                read,
                state,
                intrinsicWriteFacts,
              ),
          });
    const privateTargets = createSemanticPrivateMemberTargets(state);
    const includeUnknownResults =
      customContext || semanticFreshObjectFactsReady(state);
    const unknownResult = createSemanticUnknownCallableResults(
      state,
      receiverObjects.isFreshObject,
      definiteObject,
    );
    const classStages = createSemanticClassConstructionStages(
      state,
      definiteObject,
      receiverObjects.isFreshObject,
      includeUnknownResults,
    );
    const unknownConstructionRoots = new Set<t.Node>();
    const groups = new Map<
      string,
      { node: t.Node; targets: readonly t.Function[] }
    >();
    const paths = new WeakMap<t.Node, readonly string[]>();
    const covered = new WeakSet<t.Node>();
    const localPath = (node: t.Node): readonly string[] | undefined => {
      const current = unwrapJavaScriptExpression(node).node;
      const cached = paths.get(current);
      if (cached !== undefined) return cached;
      const functions = targets(current);
      if (functions.length > 0) {
        const id = String(groups.size);
        groups.set(id, { node: current, targets: functions });
        const path = ["intrinsic", "local-receiver", id];
        paths.set(current, path);
        return path;
      }
      if (
        t.isMemberExpression(current) ||
        t.isOptionalMemberExpression(current)
      ) {
        const key = semanticStaticPropertyKey(
          current.property,
          current.computed,
        );
        if (key === "call" || key === "apply" || key === "bind") {
          const path = localPath(current.object);
          if (path !== undefined) return [...path, key];
        }
      }
      return intrinsics.intrinsicPath(current);
    };
    const invocationFacts = intrinsicWriteFacts ?? {
      ambientWrites: state.ambientWrites,
      ambientWriteEffects: state.ambientWriteEffects,
      opaqueGlobalSites: state.opaqueEffects.globalSites,
      get complete() {
        return semanticFreshObjectFactsReady(state);
      },
    };
    const sourceCapture = createSemanticFunctionValueCapture(state, {
      bindingReadMayHaveChanged: (binding, read) =>
        invocationFacts.complete !== true ||
        semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
        semanticGlobalBindingReadMayHaveChanged(
          binding,
          read,
          state,
          invocationFacts,
        ),
      ownSlotUnchanged: (owner, key, read) =>
        semanticAmbientOwnSlotUnchanged(state, owner, key, read),
    });
    const invocations = createSemanticModuleInterop(state, {
      intrinsicPath: localPath,
      boundFunctionWriteFacts: invocationFacts,
      sourceFunctionCapture: sourceCapture,
    });
    // Only the ambient owner can supply complete canonical mutation facts.
    // Provisional queries retain uncertainty until that snapshot is available.
    const constructionInvocations = createSemanticModuleInterop(state, {
      intrinsicPath: intrinsics.intrinsicPath,
      intrinsicWriteFacts: invocationFacts,
    });
    const retain = (target: t.Function, receiver?: t.Node) => {
      const values = indexed.get(target) ?? new Set<t.Node>();
      if (receiver !== undefined) values.add(receiver);
      indexed.set(target, values);
    };
    const privateReceivers = (
      name: t.PrivateName,
    ): readonly t.Node[] | undefined => {
      const declaration = privateTargets(name);
      if (declaration === undefined) return undefined;
      const values = new Set<t.Node>();
      if (declaration.members.some((member) => member.static))
        values.add(declaration.owner);
      if (declaration.members.some((member) => !member.static)) {
        // A successful private lookup checks the declaring class's brand. Its
        // instance starts fresh unless super() supplies an existing object.
        // Unknown bases and returned values cannot prove global exclusion.
        const inherited =
          declaration.owner.superClass == null
            ? []
            : returned(declaration.owner.superClass).map(({ node }) => node);
        for (const node of inherited) values.add(node);
        if (
          declaration.lineage.unknownBase !== undefined ||
          declaration.lineage.classes.some(
            (owner) =>
              owner.superClass != null &&
              !receiverObjects.isFreshObject(owner.superClass),
          ) ||
          inherited.some((node) => !receiverObjects.isFreshObject(node))
        )
          values.add(state.program);
      }
      return [...values];
    };
    const retainPrivate = (target: t.Function, values: readonly t.Node[]) => {
      retain(target);
      for (const receiver of values) retain(target, receiver);
    };
    const construct = (
      callee: t.Node,
      allocation: t.Node,
      newTarget = callee,
    ) => {
      // An explicit returned object does not replace the fresh receiver used
      // inside a base constructor.
      for (const target of targets(callee)) retain(target);
      const add = (owner: t.Node, value: SemanticConstructedReceiver) => {
        const values = constructed.get(owner) ?? [];
        values.push(value);
        constructed.set(owner, values);
      };
      const addUnknown = (
        owner: t.Node,
        value: SemanticUnknownConstructorReceiver,
      ) => {
        const values = unknownReceivers.get(owner) ?? [];
        values.push(value);
        unknownReceivers.set(owner, values);
      };
      const completion = completions.get(allocation) ?? {
        receivers: [],
        unknown: [],
        sources: [],
        complete: receiverObjects.isFreshObject(callee),
      };
      completions.set(allocation, completion);
      for (const { node: target, projection } of constructorValues(callee)) {
        if (projection.length !== 0) continue;
        completion.sources.push(target);
        const unknown: SemanticUnknownConstructorReceiver = {
          kind: "unknown-constructor-receiver",
          allocation,
          source: target,
        };
        const identity = semanticAllocatedReceiverIdentity(allocation);
        const stages = t.isClass(target) ? classStages(target) : [];
        const activations: t.Node[] = t.isFunction(target)
          ? [target]
          : stages.flatMap((stage) => [
              ...(stage.constructor === undefined ? [] : [stage.constructor]),
              ...stage.fields.map((field) => field.node),
            ]);
        for (const owner of activations) {
          const sites = activationSites.get(owner) ?? new Set();
          sites.add(allocation);
          activationSites.set(owner, sites);
        }
        const base = {
          identity,
          allocation,
          prototypeSource: newTarget,
          prototypeSourceLocal: receiverObjects.isFreshObject(newTarget),
          target,
          activations,
        };
        if (t.isFunction(target)) {
          const receiver = { ...base, fields: [] };
          add(target, receiver);
          if (semanticConstructorKeepsReceiver(target, definiteObject))
            completion.receivers.push(receiver);
          if (includeUnknownResults && unknownResult(target))
            completion.unknown.push(unknown);
        } else {
          const fields: SemanticConstructedReceiver["fields"][number][] = [];
          for (const stage of stages) {
            if (stage.unknownReceiver) {
              for (const field of stage.fields) addUnknown(field.node, unknown);
              if (stage.constructor !== undefined)
                addUnknown(stage.constructor, unknown);
            }
            if (!stage.fresh) continue;
            for (const field of stage.fields) {
              add(field.node, { ...base, fields: [...fields] });
              if (field.key.kind === "public")
                fields.push({
                  key: field.key.name,
                  node: field.node,
                  value: field.value,
                  own: stage.local,
                });
            }
            if (stage.constructor !== undefined)
              add(stage.constructor, {
                ...base,
                fields: [...fields],
              });
          }
          if (stages.at(-1)?.keepsReceiver)
            completion.receivers.push({ ...base, fields: [...fields] });
          if (stages.at(-1)?.unknownResult) completion.unknown.push(unknown);
        }
      }
      covered.add(callee);
    };
    const sites = parsedReceiverSites(state);
    const inactiveNodes = new WeakSet<t.Node>();
    sites.forEach(([node, parent]) => {
      if (
        inactiveDefaults.has(node) ||
        (parent !== null && inactiveNodes.has(parent))
      ) {
        inactiveNodes.add(node);
        return;
      }
      if (t.isPrivateName(node)) {
        // A decorator can expose the original callable even when the private
        // slot itself never leaves the class's lexical scope.
        for (const member of privateTargets(node)?.members ?? [])
          if (
            member.key.kind === "private" &&
            member.key.declaration === node &&
            member.decorated &&
            member.value !== null
          )
            for (const target of contents(member.value))
              retain(target, state.program);
      }
      if (
        (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
        t.isPrivateName(node.property)
      ) {
        const declaration = privateTargets(node.property);
        const values = privateReceivers(node.property);
        const parent = state.parentsByNode.get(node);
        const assignment =
          t.isAssignmentExpression(parent) && parent.left === node;
        const update = t.isUpdateExpression(parent) && parent.argument === node;
        for (const member of declaration?.members ?? []) {
          if (
            values !== undefined &&
            t.isFunction(member.value) &&
            ((member.kind === "get" &&
              (!assignment || parent.operator !== "=")) ||
              (member.kind === "set" && (assignment || update)))
          )
            retainPrivate(member.value, values);
        }
      }
      if (t.isNewExpression(node)) {
        construct(node.callee, node);
        return;
      }
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return;
      let invocation = invocations.intrinsicInvocation(node);
      if (invocation?.path.join(".") === "intrinsic.Reflect.construct")
        invocation = constructionInvocations.intrinsicInvocation(node);
      if (
        invocation?.kind === "known" &&
        invocation.path.join(".") === "intrinsic.Reflect.construct"
      ) {
        const target = invocation.arguments?.[0];
        const newTarget = invocation.arguments?.[2];
        if (t.isExpression(target))
          construct(
            target,
            node,
            t.isExpression(newTarget) ? newTarget : target,
          );
        return;
      }
      if (
        invocation?.path.length !== 3 ||
        invocation.path[1] !== "local-receiver"
      )
        return;
      const group = groups.get(invocation.path[2]!);
      if (group === undefined) return;
      covered.add(group.node);
      for (const read of invocation.callableReads ?? []) covered.add(read);
      const callee = unwrapJavaScriptExpression(node.callee).node;
      const receiver = invocation.receiver ?? invocation.memberReceiver;
      const branded =
        invocation.receiver === undefined &&
        callee === group.node &&
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        t.isPrivateName(callee.property)
          ? privateReceivers(callee.property)
          : undefined;
      for (const target of group.targets) {
        const activations = activationSites.get(target) ?? new Set();
        activations.add(node);
        activationSites.set(target, activations);
        if (branded !== undefined) {
          retainPrivate(target, branded);
          continue;
        }
        retain(target, receiver);
        if (
          invocation.receiverUncertain === true ||
          t.isSpreadElement(receiver) ||
          (invocation.kind === "opaque" && receiver === undefined)
        )
          retain(target, state.program);
        // Unknown arguments can be nullish. Only proven objects/non-null
        // literals exclude sloppy receiver substitution; reads remain strict.
        const value =
          receiver === undefined
            ? undefined
            : unwrapJavaScriptExpression(receiver).node;
        const nonNullish =
          value !== undefined &&
          (definiteObject(value) ||
            (t.isLiteral(value) && !t.isNullLiteral(value)) ||
            ["globalThis", "global", "window", "self", "module"].some((name) =>
              isUnshadowedGlobal(value, state, name),
            ));
        if (!nonNullish && !semanticStrictContext(target, state))
          retain(target, state.program);
      }
    });
    // Recovered calls are not a complete use set: stored, returned or passed
    // callable values can be invoked through a receiver we did not recover.
    const inactiveTargets = new Set<t.Function>();
    const storedSources: [t.Node, t.Node][] = [];
    const escapedValues = new WeakSet<t.Node>();
    sites.forEach(([node, initialParent]) => {
      let parent = initialParent;
      if (inactiveNodes.has(node)) {
        if (t.isFunction(node)) inactiveTargets.add(node);
        else if (
          parent !== null &&
          t.isIdentifier(node) &&
          t.isReferenced(node, parent, state.parentsByNode.get(parent))
        )
          for (const target of contents(node)) inactiveTargets.add(target);
        return;
      }
      if (parent !== null && t.isClassDeclaration(node)) {
        storedSources.push([node, parent]);
        if (
          t.isExportNamedDeclaration(parent) ||
          t.isExportDefaultDeclaration(parent)
        )
          unknownConstructionRoots.add(node);
        return;
      }
      if (parent === null || !t.isExpression(node)) return;
      if (
        t.isIdentifier(node) &&
        !t.isReferenced(node, parent, state.parentsByNode.get(parent))
      )
        return;
      let current: t.Node = node;
      // Follow edges that select this value before deciding whether it is
      // stored, consumed, or discarded. The expression's syntax alone does
      // not distinguish an escaped instance from a local method receiver.
      for (;;) {
        if (covered.has(current)) return;
        // Plain assignment evaluates an address without reading its old value.
        // Computed keys and the RHS remain independent evaluated use sites.
        if (
          t.isAssignmentExpression(parent, { operator: "=" }) &&
          parent.left === current
        )
          return;
        if (
          (t.isSequenceExpression(parent) &&
            parent.expressions.at(-1) !== current) ||
          (t.isConditionalExpression(parent) && parent.test === current) ||
          (t.isExpressionStatement(parent) && parent.expression === current) ||
          (t.isUnaryExpression(parent) &&
            ["void", "typeof", "!"].includes(parent.operator)) ||
          ((t.isIfStatement(parent) ||
            t.isWhileStatement(parent) ||
            t.isDoWhileStatement(parent)) &&
            parent.test === current) ||
          (t.isForStatement(parent) &&
            (parent.init === current ||
              parent.test === current ||
              parent.update === current))
        )
          return;
        if (
          parent === null ||
          !(
            ((t.isMemberExpression(parent) ||
              t.isOptionalMemberExpression(parent)) &&
              parent.object === current) ||
            unwrapJavaScriptExpression(parent).node === current ||
            t.isSequenceExpression(parent) ||
            t.isConditionalExpression(parent) ||
            t.isLogicalExpression(parent) ||
            (t.isAssignmentExpression(parent, { operator: "=" }) &&
              parent.right === current &&
              t.isIdentifier(parent.left) &&
              resolveSemanticBindingState(
                state,
                parent.left,
                parent.left.name,
              ) !== undefined)
          )
        )
          break;
        current = parent;
        parent = state.parentsByNode.get(current) ?? null;
      }
      if (
        (t.isVariableDeclarator(parent) &&
          parent.init === current &&
          t.isIdentifier(parent.id)) ||
        ((t.isObjectProperty(parent) ||
          t.isClassProperty(parent) ||
          t.isClassPrivateProperty(parent) ||
          t.isClassAccessorProperty(parent)) &&
          parent.value === current) ||
        t.isArrayExpression(parent) ||
        (t.isSpreadElement(parent) &&
          t.isArrayExpression(state.parentsByNode.get(parent))) ||
        (t.isClass(parent) && parent.superClass === current)
      ) {
        storedSources.push([node, parent]);
        // A stored class may be constructed through an unrecovered consumer.
        unknownConstructionRoots.add(node);
        return;
      }
      if (escapedValues.has(current)) return;
      escapedValues.add(current);
      // Literal invocation arrays can contain a consumed callable selection.
      // Walk their leaves without hiding other arguments or nested contents.
      const values = [current];
      while (values.length > 0) {
        const value = values.pop();
        if (value === undefined || covered.has(value)) continue;
        unknownConstructionRoots.add(value);
        const unwrapped = unwrapJavaScriptExpression(value).node;
        if (t.isArrayExpression(unwrapped)) {
          for (const element of unwrapped.elements)
            if (element !== null)
              values.push(
                t.isSpreadElement(element) ? element.argument : element,
              );
          continue;
        }
        for (const target of contents(value)) {
          unknownActivations.add(target);
          retain(target, state.program);
        }
      }
    });
    // Construction escape tracking needs the union, rather than a separate
    // alias walk for each stored value. The callable owner shares completed
    // prefixes without changing any root's selection or cycle context.
    for (const { node, projection } of constructorValues.fromRoots([
      ...unknownConstructionRoots,
    ])) {
      if (!t.isClass(node) || projection.length !== 0) continue;
      for (const stage of classStages(node)) {
        if (stage.constructor !== undefined)
          unknownActivations.add(stage.constructor);
        for (const field of stage.fields) unknownActivations.add(field.node);
      }
    }
    // An explicitly unused default is a known non-invocation. Keep independent
    // calls and escapes, and leave unobserved stored/exported uses unknown.
    for (const [node, parent] of storedSources) {
      if (inactiveTargets.size === 0) break;
      const declaration = state.parentsByNode.get(parent);
      // A local function initializer defines the target rather than using it.
      if (
        t.isFunction(node) &&
        t.isVariableDeclarator(parent) &&
        !t.isExportNamedDeclaration(
          declaration === undefined
            ? undefined
            : state.parentsByNode.get(declaration),
        )
      )
        continue;
      for (const target of contents(node)) inactiveTargets.delete(target);
    }
    for (const target of inactiveTargets) {
      const parent = state.parentsByNode.get(target);
      if (
        !indexed.has(target) &&
        !t.isExportNamedDeclaration(parent) &&
        !t.isExportDefaultDeclaration(parent)
      )
        retain(target);
    }
  };
  const returned = createSemanticReturnedReferences(state, isDefinitelyObject);
  const inheritedReceiver = (owner: t.Node): readonly t.Node[] => {
    if (
      !(
        (t.isClassMethod(owner) && owner.kind === "constructor") ||
        ((t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
          !owner.static)
      )
    )
      return [];
    const body = state.parentsByNode.get(owner);
    const declaring =
      body === undefined ? undefined : state.parentsByNode.get(body);
    return t.isClass(declaring) && declaring.superClass != null
      ? returned(declaring.superClass).map(({ node }) => node)
      : [];
  };
  const refresh = () => {
    const captured = semanticAmbientIdentitySourcesReady(state);
    if (capturesReady !== captured) {
      capturesReady = captured;
      receivers = undefined;
    }
    const ready = semanticFreshObjectFactsReady(state);
    const slotsReady = semanticAmbientOwnSlotFactsReady(state);
    if (
      (!customContext && factsReady !== ready) ||
      ownSlotFactsReady !== slotsReady
    ) {
      // Frozen binding proofs still acquire completed slot facts. A receiver
      // indexed while resolving escapes must not retain provisional failures.
      factsReady = ready;
      ownSlotFactsReady = slotsReady;
      receivers = undefined;
    }
  };
  const query = (node: t.ThisExpression): readonly t.Node[] => {
    refresh();
    const owner = lexicalOwner(node);
    if (t.isProgram(owner))
      return javaScriptRuntimeContext(owner) === "unknown" ? [owner] : [];
    if (
      t.isStaticBlock(owner) ||
      ((t.isClassProperty(owner) ||
        t.isClassPrivateProperty(owner) ||
        t.isClassAccessorProperty(owner)) &&
        owner.static)
    ) {
      // Static initialization uses the declaring constructor, including in
      // lexical arrows. Its inherited helpers can still be shared intrinsics.
      const body = state.parentsByNode.get(owner);
      const declaring =
        body === undefined ? undefined : state.parentsByNode.get(body);
      return t.isClass(declaring) ? [declaring] : [];
    }
    if (!t.isFunction(owner)) return inheritedReceiver(owner);
    if (receivers === undefined) indexReceivers();
    const known = receivers?.get(owner);
    // Unrecovered calls/accessors may choose the global receiver. Absence of
    // a recovered call is not evidence that a source-visible write is harmless.
    return known === undefined
      ? [state.program, ...inheritedReceiver(owner)]
      : [...known, ...inheritedReceiver(owner)];
  };
  const result: ReceiverQuery = Object.assign(query, {
    constructed: (node: t.ThisExpression) => {
      const owner = lexicalOwner(node);
      if (
        t.isProgram(owner) ||
        t.isStaticBlock(owner) ||
        ((t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
          owner.static)
      )
        return [];
      query(node);
      if (receivers === undefined) indexReceivers();
      return constructed.get(owner) ?? [];
    },
    completion: (node: t.Node) => {
      if (
        !t.isNewExpression(node) &&
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node)
      )
        return undefined;
      refresh();
      if (receivers === undefined) indexReceivers();
      const completion = completions.get(node);
      return completion?.sources.length ? completion : undefined;
    },
    unknown: (node: t.ThisExpression) => {
      const owner = lexicalOwner(node);
      if (
        t.isProgram(owner) ||
        t.isStaticBlock(owner) ||
        ((t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
          owner.static)
      )
        return [];
      query(node);
      if (receivers === undefined) indexReceivers();
      return unknownReceivers.get(owner) ?? [];
    },
    allocatedBefore: (
      receiver: SemanticConstructedReceiver,
      mutation: t.Node,
    ) => {
      let owner: t.Node | undefined = mutation;
      while (owner !== undefined && !receiver.activations.includes(owner))
        owner = state.parentsByNode.get(owner);
      if (owner === undefined || unknownActivations.has(owner)) return false;
      let parent = state.parentsByNode.get(receiver.allocation);
      while (parent !== undefined) {
        if (t.isLoop(parent) || t.isFunction(parent)) return false;
        parent = state.parentsByNode.get(parent);
      }
      return [...(activationSites.get(owner) ?? [])].every(
        (site) =>
          site === receiver.allocation ||
          semanticEffectTiming(receiver.allocation, site, state) === "after",
      );
    },
  });
  if (!customContext) receiverQueries.set(state, result);
  return result;
};
