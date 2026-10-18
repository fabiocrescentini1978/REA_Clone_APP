import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  staticObjectProperty,
  staticObjectOwnProperty,
  semanticObjectPrototypeProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
  semanticIntrinsicMutation,
  semanticIntrinsicMutationTargets,
  type JavaScriptIntrinsicMutationRecipient,
} from "./javascriptElectronMemberWrites.js";
import {
  completeSemanticFreshObjectFacts,
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticMemberEffect,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticRequireOrigin,
  semanticRequireFunctionValue,
  semanticInitialModuleDelegateDataProperty,
  semanticModuleDelegateWriteOwner,
} from "./javascriptSemanticRequireOrigin.js";
import {
  semanticCallableValueIdentity,
  semanticPossibleFunctionValueIdentities,
  semanticSourceFunctionValueIdentities,
  semanticOrdinaryFunctionValueIdentities,
  semanticUnknownReferenceIdentities,
  isSemanticUnknownReferenceIdentity,
  semanticLiteralInheritedValueIdentities,
  semanticBuiltinPrototypeDataWritePossible,
  semanticBuiltinDataPrototypeMayBeReached,
  semanticBuiltinDataPrototypeOwner,
  SEMANTIC_PHYSICAL_PROTOTYPE,
  SEMANTIC_SOURCE_PROTO_DESCRIPTOR,
  type SemanticFunctionValueProjection,
} from "./javascriptSemanticFunctionValues.js";
import {
  semanticNativePrototypeGetterPossible,
  semanticEverySourcePropertySlot,
  semanticOwnReferenceCandidates,
  semanticClassPropertyDescriptors,
} from "./javascriptSemanticObjectReferences.js";
import { semanticRequireShimOrigin } from "./javascriptRequireShimOrigin.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  createSemanticSharedStorageIdentities,
  isSemanticAllocatedReceiverIdentity,
  type SemanticLocalIdentity,
  type SemanticStorageIdentity,
  isSemanticSharedStorageIdentity,
  semanticSharedStorageHasDescriptorFacts,
  type SemanticSharedStorageIdentity,
  type SemanticAllocatedReceiverIdentity,
} from "./javascriptSemanticStorageIdentities.js";
import {
  createSemanticPrecedingEffectIndex,
  semanticBindingAtRead,
  semanticDefiniteMutationPrecedesRead,
  semanticMutationPrecedesLexicalRead,
  semanticEffectTiming,
  semanticEffectFollowsInitialCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticCopiedReferencePath,
  semanticLiteralObjectReferenceSources,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import {
  semanticIntrinsicDataStores,
  semanticIterationSources,
  type SemanticIterationSource,
} from "./javascriptSemanticIterationSources.js";
import {
  createSemanticFunctionValueReferences,
  createSemanticReturnedReferences,
  createSemanticUnknownCallableResults,
  createSemanticStaticClassSlotReferences,
} from "./javascriptSemanticReturnedReferences.js";
import {
  createSemanticReceiverReferences,
  type SemanticConstructedReceiver,
} from "./javascriptSemanticReceiverReferences.js";
import {
  semanticArrayIndex,
  semanticPropertyPathMayAffect,
  SemanticPropertyPathCoverage,
} from "./javascriptSemanticPropertyPaths.js";
import {
  semanticBindingCanBeRebound,
  semanticAmbientWriteMayMatch,
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
  type SemanticGlobalBindingFacts,
} from "./javascriptSemanticOpaqueEffects.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import {
  createSemanticGlobalRootReplacementQuery,
  semanticGlobalRootHasDataDescriptor,
} from "./javascriptSemanticGlobalRootReplacements.js";

const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

/** Global self references retain object identity, rather than adding a property. */
const canonicalAmbientPath = <
  Key extends SemanticFunctionValueProjection[number],
>(
  path: readonly Key[],
): readonly (Key | string | null)[] => {
  if (isSemanticUnknownReferenceIdentity(path)) return [null];
  if (path[0] !== "global") return path;
  let firstProperty = 1;
  while (
    typeof path[firstProperty] === "string" &&
    GLOBAL_OBJECT_NAMES.includes(path[firstProperty] as string)
  )
    firstProperty += 1;
  return ["global", ...path.slice(firstProperty)];
};

type AmbientPath = readonly (string | null)[];

/** Undefined means a cyclic or conflicting projection can select any depth. */
type AmbientProjection = AmbientPath | undefined;
type AmbientReplacementKey = string | typeof SEMANTIC_PHYSICAL_PROTOTYPE;
const capturedReplacement = (
  sources: readonly SemanticIterationSource[] | undefined,
  read: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): SemanticIterationSource | undefined => {
  if (read === undefined) return undefined;
  let selected: SemanticIterationSource | undefined;
  for (const source of sources ?? [])
    if (
      semanticDefiniteMutationPrecedesRead(
        source.mutation,
        read,
        state.parentsByNode,
      ) &&
      (selected === undefined ||
        semanticEffectTiming(source.mutation, selected.mutation, state) ===
          "before")
    )
      selected = source;
  return selected;
};
type AmbientSelectionProjection = SemanticFunctionValueProjection | undefined;
const propertySelector = (
  key: SemanticFunctionValueProjection[number] | undefined,
) =>
  key === SEMANTIC_SOURCE_PROTO_DESCRIPTOR
    ? "__proto__"
    : typeof key === "symbol"
      ? undefined
      : key;
const hasInternalSelector = (path: AmbientSelectionProjection): boolean =>
  path?.some((key) => typeof key === "symbol") === true;
type AmbientCaptures = readonly (t.Node | undefined)[];

/** Builtin exports select the same possible values as their ambient owners. */
const builtinValuePaths = (
  origin: JavaScriptModuleOrigin,
  projection: AmbientSelectionProjection,
): readonly SemanticFunctionValueProjection[] => {
  const processOrigin = ["process", "node:process"].includes(origin.specifier);
  if (!processOrigin && !["module", "node:module"].includes(origin.specifier))
    return [];
  const path = [...origin.importedPath, ...(projection ?? [null])];
  if (processOrigin) {
    if (origin.resolutionMode === "require")
      return [["global", "process", ...path]];
    if (path[0] === "default") return [["global", "process", ...path.slice(1)]];
    if (path[0] === "mainModule") return [["global", "process", ...path]];
    // An unknown namespace export may select either the process object or a
    // named main Module. Namespace own slots never become ambient owners.
    return path[0] === null
      ? [
          ["global", "process", ...path.slice(1)],
          ["global", "process", ...path],
        ]
      : [];
  }
  // ESM namespace slots select the constructor; the namespace is not itself it.
  if (origin.resolutionMode !== "require") {
    const selected = path.shift();
    if (selected === "createRequire")
      return [["commonjs-module", "constructor", "createRequire", ...path]];
    if (selected !== "default" && selected !== "Module" && selected !== null)
      return [];
  }
  return [["commonjs-module", "constructor", ...path]];
};

const joinAmbientProjection = (
  left: AmbientProjection,
  right: AmbientProjection,
): AmbientProjection =>
  left === undefined || right === undefined || left.length !== right.length
    ? undefined
    : left.map((key, index) => (key === right[index] ? key : null));

interface AmbientReferenceFacts {
  readonly sourceSlotsComplete?: () => boolean;
  readonly globalRootReplacement?: (
    name: string,
    read: t.Node,
  ) => SemanticIterationSource | undefined;
  readonly hasGlobalRootStores?: () => boolean;
  readonly stores: WeakMap<
    SemanticStorageIdentity,
    Map<SemanticIterationSource, AmbientProjection>
  >;
  readonly sharedStorage: ReturnType<
    typeof createSemanticSharedStorageIdentities
  >;
  readonly replacements: WeakMap<
    SemanticStorageIdentity,
    Map<AmbientReplacementKey, SemanticIterationSource[]>
  >;
  readonly prototypeUnchanged?: (
    owner: t.Node,
    read: t.Node,
    since?: t.Node,
  ) => boolean;
  readonly prototypeTarget: (node: t.Node) => t.Node | undefined;
  readonly freshObject: (node: t.Node) => boolean;
  /** A completed conservative binding snapshot may refine constructor results. */
  readonly definiteObject?: (node: t.Node) => boolean;
  readonly intrinsicWriteFacts?: SemanticGlobalBindingFacts;
  readonly ownDescriptorIntact?: (
    owner: t.Node,
    key: string,
    read: t.Node,
  ) => boolean;
  readonly storeKinds?: WeakMap<
    SemanticIterationSource,
    "prototype" | "own-data" | "own-slot"
  >;
  readonly ownSlotUnchanged?: (
    owner: SemanticLocalIdentity,
    key: string,
    read: t.Node,
    since?: t.Node,
    acceptedWrites?: ReadonlySet<t.Node>,
  ) => boolean;
  readonly ownSlotValueUnknown?: (
    owner: t.Node,
    key: string,
    read: t.Node,
  ) => boolean;
  /** A completed allocation proof consumed this RHS as an ordinary own store. */
  readonly ownReferenceStored?: (source: SemanticIterationSource) => void;
  readonly constructorPrototypeUnchanged?: (
    owner: t.Function | t.Class,
    read: t.Node,
  ) => boolean;
}

/**
 * Follow local object identities without equating shallow copies with their
 * sources. Writes select aliases at their capture; uncertain execution order
 * retains possible initializers. Intrinsic reads stay strict.
 */
export const createAmbientPathResolver = (
  state: JavaScriptSemanticAnalysisState,
  possibleWrites: boolean,
  facts?: AmbientReferenceFacts,
) => {
  const cached = new WeakMap<t.Node, readonly AmbientPath[]>();
  const globalSourceGuards = new Set<SemanticIterationSource>();
  const returnedReferences = createSemanticReturnedReferences(
    state,
    facts?.definiteObject,
  );
  const functionReferences = createSemanticFunctionValueReferences(
    state,
    facts?.definiteObject,
  );
  const receiverReferences = createSemanticReceiverReferences(
    state,
    facts?.definiteObject,
    facts?.intrinsicWriteFacts,
  );
  const constructedValues = new WeakMap<
    SemanticAllocatedReceiverIdentity,
    Set<SemanticConstructedReceiver>
  >();
  const intrinsics = createSemanticModuleInterop(state);
  const staticClassSlots = createSemanticStaticClassSlotReferences(
    state,
    facts?.freshObject ?? intrinsics.isFreshObject,
  );
  const bindingReadChanged = (
    binding: JavaScriptSemanticBindingState,
    read: t.Node,
  ) =>
    semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
    (semanticBindingCanBeRebound(binding) &&
      facts?.intrinsicWriteFacts !== undefined &&
      semanticGlobalBindingReadMayHaveChanged(
        binding,
        read,
        state,
        facts.intrinsicWriteFacts,
      ));
  const sourceFacts = {
    ownSlotUnchanged: (owner: t.Node, key: string, at: t.Node) =>
      facts?.ownSlotUnchanged?.(owner, key, at) === true,
    ownDescriptorIntact: (owner: t.Node, key: string, at: t.Node) =>
      facts?.ownDescriptorIntact?.(owner, key, at) === true,
    bindingReadMayHaveChanged: bindingReadChanged,
    returnedReferences,
    selectedOwnSlot: (owner: t.Node, key: string, read: t.Node) => {
      const selected = capturedReplacement(
        facts?.replacements.get(owner)?.get(key),
        read,
        state,
      );
      if (
        selected !== undefined &&
        facts?.ownSlotUnchanged?.(owner, key, read, selected.mutation) === true
      )
        return {
          status: "updated" as const,
          sources: [
            {
              node: selected.node,
              projection: selected.projection,
              writable: facts?.storeKinds?.get(selected) === undefined,
              ...(facts?.storeKinds?.get(selected) === "own-data"
                ? { data: true as const }
                : {}),
            },
          ],
        };
      return facts?.ownSlotValueUnknown?.(owner, key, read) === true
        ? { status: "unknown" as const }
        : undefined;
    },
    physicalPrototype: (owner: t.Node, read: t.Node) => {
      const selected = capturedReplacement(
        facts?.replacements.get(owner)?.get(SEMANTIC_PHYSICAL_PROTOTYPE),
        read,
        state,
      );
      if (facts?.prototypeUnchanged?.(owner, read, selected?.mutation) !== true)
        return { status: "unknown" as const };
      return selected === undefined
        ? { status: "unchanged" as const }
        : { status: "updated" as const, nodes: [selected.node] };
    },
    ownClassSlotIntact: (owner: t.Class, key: string, read: t.Node) => {
      const slot = staticClassSlots(owner, key, read);
      return (
        slot.ownLocal &&
        slot.owners.every(
          (declaring, index) =>
            facts?.ownSlotUnchanged?.(declaring, key, read) === true &&
            (index === slot.owners.length - 1 ||
              facts?.ownSlotUnchanged?.(declaring, "__proto__", read) === true),
        )
      );
    },
  };
  const syntaxReferences = (
    source: t.Node,
    projection: AmbientPath = [],
    read = source,
    presenceOnly = false,
    captures?: readonly t.Node[],
  ) =>
    semanticOwnReferenceCandidates(
      source,
      projection,
      state,
      sourceFacts,
      read,
      presenceOnly,
      captures,
    );
  // Member reads require completed own-slot facts; declaration values alone
  // cannot classify a prototype argument before the mutation index exists.
  const prototypeKind = (
    value: t.Node,
  ): "null" | "object" | "primitive" | "unknown" => {
    if (
      facts?.intrinsicWriteFacts?.complete === true &&
      semanticBuiltinDataPrototypeOwner(
        descriptorInterop.capturedIntrinsicPath(value),
      ) !== undefined
    )
      return "object";
    if ((facts?.definiteObject ?? intrinsics.isDefinitelyObject)(value))
      return "object";
    const candidates = syntaxReferences(value);
    if (!candidates.complete) return "unknown";
    let kind: "null" | "object" | "primitive" | undefined;
    for (const node of candidates.nodes) {
      const literal = readExactJavaScriptLiteral(node);
      const next = literal.found
        ? literal.value === null
          ? "null"
          : "primitive"
        : (facts?.definiteObject ?? intrinsics.isDefinitelyObject)(node)
          ? "object"
          : undefined;
      if (next === undefined || (kind !== undefined && next !== kind))
        return "unknown";
      kind = next;
    }
    return kind ?? "unknown";
  };
  const ownSourceSlotPresent = (
    source: t.Node,
    projection: AmbientPath,
    read: t.Node,
  ): boolean => syntaxReferences(source, projection, read, true).complete;
  const descriptorInterop = createSemanticModuleInterop(state, {
    intrinsicPath: intrinsics.intrinsicPath,
    ...(facts?.intrinsicWriteFacts === undefined
      ? {}
      : { intrinsicWriteFacts: facts.intrinsicWriteFacts }),
    bindingReadMayHaveChanged: bindingReadChanged,
  });
  const nativePrototypeDescriptorIntact = (
    owner: "Object" | "Function" | "Array",
    read: t.Node,
    key: string = "__proto__",
    beforeStore = false,
  ) => {
    const snapshot = facts?.intrinsicWriteFacts;
    if (
      snapshot?.complete !== true ||
      (snapshot.opaqueGlobalSites ?? []).some(
        (effect) => semanticEffectTiming(read, effect, state) !== "after",
      )
    )
      return false;
    const owners = owner === "Object" ? [owner] : [owner, "Object"];
    return owners.every((prototype) =>
      [key, "__proto__"].every(
        (selected) =>
          !semanticAmbientWriteMayMatch(
            snapshot,
            ["global", prototype, "prototype", selected],
            ({ path, node, valueOnly }) =>
              !(beforeStore && node === read) &&
              !(
                path.length === 2 &&
                path[0] === "global" &&
                path[1] === prototype
              ) &&
              !(
                beforeStore &&
                selected !== "__proto__" &&
                valueOnly === true &&
                path.length === 4 &&
                path[0] === "global" &&
                path[1] === prototype &&
                path[2] === "prototype" &&
                path[3] === selected
              ) &&
              semanticEffectTiming(read, node, state) !== "after",
          ),
      ),
    );
  };
  const prototypeAssignment = (
    owner: t.Node,
    site: t.Node,
    nativePrototypesIntact: boolean,
    allowOwnData: boolean,
  ) => {
    if (
      !t.isAssignmentExpression(site, { operator: "=" }) ||
      !t.isMemberExpression(site.left) ||
      semanticStaticPropertyKey(site.left.property, site.left.computed) !==
        "__proto__"
    )
      return false;
    const receiver = syntaxReferences(site.left.object, [], site);
    if (
      !receiver.complete ||
      receiver.nodes.length !== 1 ||
      receiver.nodes[0] !== owner
    )
      return false;
    return semanticEverySourcePropertySlot(
      owner,
      "__proto__",
      site,
      state,
      sourceFacts,
      (slot) => {
        if (
          allowOwnData &&
          (slot.kind === "updated" ||
            (slot.kind === "source" &&
              slot.unchanged &&
              (t.isObjectProperty(slot.property) ||
                slot.property.kind === "method")))
        )
          return true;
        if (!nativePrototypesIntact) return false;
        if (slot.kind === "ordinary-prototype")
          return nativePrototypeDescriptorIntact("Object", site);
        if (slot.kind === "callable-prototype")
          return nativePrototypeDescriptorIntact("Function", site);
        if (slot.kind !== "external") return false;
        const builtin = semanticBuiltinDataPrototypeOwner(
          descriptorInterop.capturedIntrinsicPath(slot.node),
        );
        return (
          builtin !== undefined &&
          nativePrototypeDescriptorIntact(builtin, site)
        );
      },
      syntaxReferences,
    );
  };
  const unknownGetterResult = createSemanticUnknownCallableResults(
    state,
    facts?.freshObject ?? intrinsics.isFreshObject,
    facts?.definiteObject ?? intrinsics.isDefinitelyObject,
    { thisIsUnknown: true },
  );
  // A descriptor lacking its own get field may inherit one from this canonical
  // object. Mutable global bindings do not replace that already captured owner.
  const ordinaryDescriptorGetterAbsent = (read: t.Node): boolean => {
    const frozen = facts?.intrinsicWriteFacts;
    if (frozen?.complete !== true) return false;
    const precedes = (site: t.Node | undefined) =>
      site === undefined ||
      !semanticEffectFollowsInitialCapture(read, site, state);
    if (
      (frozen.opaqueGlobalSites ?? state.opaqueEffects.globalSites).some(
        precedes,
      )
    )
      return false;
    return ["get", "__proto__"].every(
      (key) =>
        !semanticAmbientWriteMayMatch(
          frozen,
          ["global", "Object", "prototype", key],
          (effect) =>
            (effect.path.length === 1 || effect.path.length > 3) &&
            precedes(effect.node),
        ),
    );
  };
  const getterMayExist = (
    source: SemanticIterationSource,
    projection: AmbientPath,
  ): boolean => {
    if (projection.at(-1) !== "get") return true;
    const descriptors = syntaxReferences(
      source.node,
      projection.slice(0, -1),
      source.mutation,
    );
    return (
      !descriptors.complete ||
      descriptors.nodes.some(
        (descriptor) =>
          !semanticEverySourcePropertySlot(
            descriptor,
            "get",
            source.mutation,
            state,
            sourceFacts,
            (slot) =>
              slot.kind === "missing" ||
              (slot.kind === "ordinary-prototype" &&
                ordinaryDescriptorGetterAbsent(source.mutation)),
            syntaxReferences,
          ),
      )
    );
  };
  const functionGroups = new Map<string, readonly (t.Function | t.Class)[]>();
  const functionPaths = new WeakMap<t.Node, readonly string[]>();
  const functionInterop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const intrinsic = intrinsics.intrinsicPath(node);
      if (intrinsic !== undefined) return intrinsic;
      const prior = functionPaths.get(node);
      if (prior !== undefined) return prior;
      const references = functionReferences(node);
      const projection = references[0]?.projection;
      if (
        projection === undefined ||
        projection.some((key) => key === null) ||
        references.some(
          (reference) =>
            JSON.stringify(reference.projection) !== JSON.stringify(projection),
        )
      )
        return undefined;
      const id = String(functionGroups.size);
      functionGroups.set(
        id,
        references.map(({ node }) => node),
      );
      const path = [
        "intrinsic",
        "source-function",
        id,
        ...projection.map(String),
      ];
      functionPaths.set(node, path);
      return path;
    },
  });
  const resolve = (
    node: t.Node,
    capture?: t.Node,
    escapedContents = false,
    projection: AmbientProjection = [],
    localIdentity?: (
      node: SemanticLocalIdentity,
      path: AmbientProjection,
      captures: AmbientCaptures,
    ) => void,
    initialBinding?: JavaScriptSemanticBindingState,
    sharedIdentity?: (
      owner: SemanticSharedStorageIdentity,
      path: AmbientProjection,
    ) => void,
    localStorageRead?: (
      owner: SemanticLocalIdentity,
      path: AmbientProjection,
      captures: AmbientCaptures,
    ) => void,
  ): readonly AmbientPath[] => {
    const prior =
      possibleWrites || initialBinding !== undefined
        ? undefined
        : cached.get(node);
    if (prior !== undefined) return prior;
    const result = new Map<string, AmbientPath>();
    // The caller's write site selects initializers for the written target.
    // Reads reached through an initializer occur at their own position.
    const pending: {
      node: t.Node;
      suffix: AmbientSelectionProjection;
      captures: AmbientCaptures;
      ownOnly?: readonly number[];
      copySelection?: string | null | undefined;
      readsAtSelf?: true;
      binding?: JavaScriptSemanticBindingState;
      constructed?: SemanticConstructedReceiver;
      capturedPrototype?: SemanticConstructedReceiver;
      inheritedMember?: boolean;
    }[] = [
      {
        node,
        suffix: projection,
        captures: (projection ?? []).map(() => capture ?? node),
        ...(initialBinding === undefined ? {} : { binding: initialBinding }),
      },
    ];
    // Join projections at their producing expression, rather than enumerating
    // alias histories. Each key can only widen to a wildcard, and conflicting
    // depths widen to unknown, so diamonds and cycles have finite state.
    type Expansion = {
      suffix: AmbientSelectionProjection;
      captures: AmbientCaptures;
      ownOnly: readonly number[];
    };
    const expanded = new WeakMap<
      object,
      Map<number, Map<string | null | undefined, Expansion>>
    >();
    const prototypeExpansions = new WeakMap<
      SemanticConstructedReceiver,
      WeakMap<t.Node, Map<boolean, object>>
    >();
    const shiftedOwnOnly = (slots: readonly number[], offset: number) =>
      slots.map((slot) => slot + offset).filter((slot) => slot >= 0);
    const followStores = (
      identity: SemanticStorageIdentity,
      suffix: AmbientSelectionProjection,
      captures: AmbientCaptures,
      ownOnly: readonly number[] = [],
      copySelection?: string | null,
      context?: (typeof pending)[number],
      owner?: t.Node,
    ) => {
      let replacement: SemanticIterationSource | undefined;
      let prototypeReplacement: SemanticIterationSource | undefined;
      let capturedPrototypeReplaced = false;
      const firstKey = propertySelector(suffix?.[0]);
      const selectedAt = captures[0];
      if (typeof firstKey === "string")
        replacement = capturedReplacement(
          facts?.replacements.get(identity)?.get(firstKey),
          selectedAt,
          state,
        );
      prototypeReplacement = capturedReplacement(
        facts?.replacements.get(identity)?.get(SEMANTIC_PHYSICAL_PROTOTYPE),
        selectedAt,
        state,
      );
      for (const [source, path] of facts?.stores.get(identity) ?? []) {
        const sourceProjection = source.projection.map((key) =>
          key === null || typeof key === "object" ? null : String(key),
        );
        const copiedPrototype =
          source.propertyWrite === "set" &&
          source.propertyCopy === "value" &&
          path?.length === 1 &&
          path[0] === null;
        const lookup =
          source.propertyLookup === undefined
            ? owner
            : source.propertyLookup.target;
        const physicalStore =
          facts?.storeKinds?.get(source) === "prototype" ||
          (facts?.storeKinds?.get(source) === undefined &&
            path?.length === 1 &&
            (path[0] === "__proto__" || copiedPrototype) &&
            ((source.propertyLookup !== undefined && lookup === undefined) ||
              (lookup !== undefined &&
                ((source.propertyLookup === undefined &&
                  context?.constructed !== undefined) ||
                  semanticNativePrototypeGetterPossible(
                    lookup,
                    source.mutation,
                    state,
                    sourceFacts,
                    syntaxReferences,
                  )))));
        if (physicalStore) {
          const physicalProjection = copiedPrototype
            ? [...sourceProjection, "__proto__"]
            : sourceProjection;
          const physicalOwnOnly = copiedPrototype
            ? [sourceProjection.length]
            : [];
          if (
            prototypeReplacement !== undefined &&
            source !== prototypeReplacement &&
            semanticEffectTiming(
              prototypeReplacement.mutation,
              source.mutation,
              state,
            ) === "before"
          )
            continue;
          const read = captures[0];
          if (
            read !== undefined &&
            semanticEffectTiming(read, source.mutation, state) === "after"
          )
            continue;
          if (semanticReferenceSourcesInactive(source, state, "syntax-only"))
            continue;
          const selector = suffix?.[0];
          const key = propertySelector(selector);
          const nativeRead =
            selector === "__proto__" &&
            (context?.constructed !== undefined ||
              owner === undefined ||
              (!ownSourceSlotPresent(
                owner!,
                ["__proto__"],
                read ?? source.mutation,
              ) &&
                semanticNativePrototypeGetterPossible(
                  source.node,
                  read,
                  state,
                  sourceFacts,
                  syntaxReferences,
                )));
          if (selector === SEMANTIC_PHYSICAL_PROTOTYPE || nativeRead)
            pending.push({
              node: source.node,
              readsAtSelf: true,
              suffix:
                suffix === undefined
                  ? undefined
                  : [...physicalProjection, ...suffix.slice(1)],
              captures: [
                ...physicalProjection.map(() => source.mutation),
                ...captures.slice(1),
              ],
              ownOnly: [
                ...physicalOwnOnly,
                ...shiftedOwnOnly(ownOnly, physicalProjection.length - 1),
              ],
              copySelection: copiedPrototype ? "__proto__" : copySelection,
            });
          else if (
            !ownOnly.includes(0) &&
            (suffix === undefined ||
              (typeof key === "string" &&
                (owner === undefined ||
                  !ownSourceSlotPresent(
                    owner,
                    [key],
                    read ?? source.mutation,
                  ))))
          )
            pending.push({
              node: source.node,
              readsAtSelf: true,
              suffix:
                suffix === undefined
                  ? undefined
                  : [...physicalProjection, ...suffix],
              captures: [
                ...physicalProjection.map(() => source.mutation),
                ...captures,
              ],
              ownOnly: [
                ...physicalOwnOnly,
                ...shiftedOwnOnly(ownOnly, physicalProjection.length),
              ],
              copySelection: copiedPrototype ? "__proto__" : copySelection,
            });
          if (!copiedPrototype) continue;
        }
        if (suffix?.[0] === SEMANTIC_PHYSICAL_PROTOTYPE) continue;
        const selected =
          suffix === undefined ||
          path === undefined ||
          path.every(
            (key, index) =>
              index >= suffix.length ||
              key === null ||
              suffix[index] === null ||
              key === propertySelector(suffix[index]),
          );
        if (
          !selected ||
          (suffix !== undefined &&
            path !== undefined &&
            suffix.length < path.length &&
            !escapedContents)
        )
          continue;
        if (
          context?.capturedPrototype !== undefined &&
          path?.length === 1 &&
          path[0] === "prototype"
        ) {
          if (
            receiverReferences.allocatedBefore(
              context?.capturedPrototype,
              source.mutation,
            )
          )
            continue;
          capturedPrototypeReplaced ||= semanticDefiniteMutationPrecedesRead(
            source.mutation,
            context?.capturedPrototype.allocation,
            state.parentsByNode,
          );
          const candidate = t.isCallExpression(source.node)
            ? intrinsics.intrinsicInvocation(source.node)
            : undefined;
          const createsObject =
            candidate?.path.join(".") === "intrinsic.Object.create";
          // A nominal factory is a possible source. Excluding its inherited
          // contents requires the captured factory's frozen dependency proof.
          const creation =
            facts?.intrinsicWriteFacts?.complete === true &&
            t.isCallExpression(source.node)
              ? descriptorInterop.intrinsicInvocation(source.node)
              : candidate;
          if (
            createsObject &&
            !(
              creation?.kind === "known" &&
              creation.path.join(".") === "intrinsic.Object.create" &&
              t.isNullLiteral(creation.arguments?.[0]) &&
              creation.arguments?.[1] === undefined
            ) &&
            (suffix === undefined || suffix.length > 1)
          )
            for (const identity of semanticUnknownReferenceIdentities())
              retain(identity);
          if (!intrinsics.isDefinitelyObject(source.node) && !createsObject)
            for (const identity of semanticLiteralInheritedValueIdentities(
              "object",
              suffix?.slice(1) ?? [null],
            ))
              retain(identity);
        }
        if (semanticReferenceSourcesInactive(source, state, "syntax-only"))
          continue;
        if (
          isSemanticSharedStorageIdentity(identity) &&
          facts?.intrinsicWriteFacts !== undefined &&
          facts.hasGlobalRootStores?.() === true &&
          source.target !== undefined &&
          !globalSourceGuards.has(source)
        ) {
          const selected = new Set<SemanticSharedStorageIdentity>();
          const local = new Set<SemanticLocalIdentity>();
          globalSourceGuards.add(source);
          const paths = resolve(
            source.target.object,
            source.mutation,
            false,
            [],
            (owner, path) => {
              if (path?.length === 0) local.add(owner);
            },
            undefined,
            (owner, path) => {
              if (path?.length === 0) selected.add(owner);
            },
          );
          globalSourceGuards.delete(source);
          // An unresolved receiver may still be the original intrinsic. Only
          // complete fresh local alternatives can exclude that shared owner.
          if (!selected.has(identity) && paths.length === 0 && local.size > 0)
            continue;
        }
        // A definite first-slot replacement also cuts paths through its old
        // contents. Unknown order and captured earlier slots remain possible.
        if (
          replacement !== undefined &&
          path?.[0] === firstKey &&
          semanticEffectTiming(replacement.mutation, source.mutation, state) ===
            "before"
        )
          continue;
        const selectedAt =
          path === undefined ? undefined : captures[path.length - 1];
        // Only overlapping stores need ordering. Unrelated properties cannot
        // replace this reference and must not replay costly timing queries.
        // Unknown order remains a possible alias, including deferred calls.
        if (
          selectedAt !== undefined &&
          semanticEffectTiming(selectedAt, source.mutation, state) === "after"
        )
          continue;
        const remaining =
          suffix === undefined || path === undefined
            ? undefined
            : suffix.slice(path.length);
        const copyKey =
          source.propertyCopy === undefined
            ? []
            : [propertySelector(suffix?.[(path?.length ?? 1) - 1]) ?? null];
        const selectedProjection = [
          ...sourceProjection,
          ...copyKey,
          ...(source.propertyCopy === "descriptor"
            ? [source.invocationResult ? "get" : "value"]
            : []),
        ];
        if (source.invocationResult === true) {
          // Bulk definitions examine only descriptors in own enumerable source
          // slots. A missing selected key cannot invoke an inherited getter.
          if (
            source.propertyCopy !== undefined &&
            syntaxReferences(
              source.node,
              [
                ...source.projection.map((key) =>
                  key === null || typeof key === "object" ? null : String(key),
                ),
                ...copyKey,
              ],
              source.mutation,
            ).absent
          )
            continue;
          const getters = syntaxReferences(
            source.node,
            selectedProjection,
            source.mutation,
          );
          let unknown =
            !getters.complete && getterMayExist(source, selectedProjection);
          for (const candidate of getters.nodes) {
            if (!t.isFunction(candidate)) {
              if (
                !t.isClass(candidate) &&
                !readExactJavaScriptLiteral(candidate).found &&
                !(facts?.freshObject ?? intrinsics.isFreshObject)(candidate)
              )
                unknown = true;
              continue;
            }
            // The callable owner also handles an accessor used to produce the
            // descriptor's getter, preserving the two invocation stages.
            const targets = functionReferences(candidate);
            if (targets.length === 0) unknown = true;
            for (const target of targets) {
              if (
                !t.isFunction(target.node) ||
                target.projection.length !== 0
              ) {
                unknown = true;
                continue;
              }
              unknown ||= unknownGetterResult(target.node);
              for (const value of returnedReferences(target.node))
                pending.push({
                  node: value.node,
                  suffix:
                    remaining === undefined
                      ? undefined
                      : [
                          ...value.projection.map((key) =>
                            key === null || typeof key === "object"
                              ? null
                              : String(key),
                          ),
                          ...remaining,
                        ],
                  captures: [
                    ...value.projection.map(() => source.mutation),
                    ...(path === undefined ? [] : captures.slice(path.length)),
                  ],
                  ownOnly: shiftedOwnOnly(
                    ownOnly,
                    value.projection.length - (path?.length ?? captures.length),
                  ),
                  copySelection:
                    source.propertyCopy === undefined
                      ? copySelection
                      : copyKey[0],
                  readsAtSelf: true,
                });
            }
          }
          // Return classification cannot contribute to its own weak snapshot.
          if (
            unknown &&
            facts?.intrinsicWriteFacts !== undefined &&
            facts.sourceSlotsComplete?.() === true
          )
            for (const identity of semanticUnknownReferenceIdentities())
              retain(identity);
          continue;
        }
        pending.push({
          node: source.node,
          copySelection:
            source.propertyCopy === undefined ? copySelection : copyKey[0],
          ...(context?.capturedPrototype !== undefined && path?.length === 0
            ? { capturedPrototype: context?.capturedPrototype }
            : {}),
          readsAtSelf: true,
          ownOnly: [
            ...shiftedOwnOnly(
              ownOnly,
              selectedProjection.length - (path?.length ?? captures.length),
            ),
            ...(source.propertyCopy === undefined
              ? []
              : [source.projection.length]),
          ],
          captures: [
            ...selectedProjection.map(() => source.mutation),
            ...(path === undefined ? [] : captures.slice(path.length)),
          ],
          suffix:
            remaining === undefined
              ? undefined
              : [...selectedProjection, ...remaining],
        });
      }

      return { replacement, prototypeReplacement, capturedPrototypeReplaced };
    };
    // Shared heap owners can be reached through many different source nodes.
    // Keep their expansion context alongside the AST worklist, within this
    // query only: stores and descriptor facts may change between queries.
    const expandedStorage = new WeakMap<
      SemanticSharedStorageIdentity,
      Set<string>
    >();
    const storageCaptureIds = new WeakMap<t.Node, number>();
    let nextStorageCaptureId = 0;
    const selectStorage = (
      storage: SemanticFunctionValueProjection,
      offset: number,
      owner: readonly string[],
      readCaptures: AmbientCaptures,
      copySelection?: string | null,
    ) => {
      // CommonJS wrapper storage keeps its existing nominal-path owner. It
      // is not a global binding or a shared builtin object in this graph.
      if (!semanticSharedStorageHasDescriptorFacts(owner)) return;
      const suffix = storage.slice(owner.length);
      if (hasInternalSelector(suffix)) return;
      const identity = facts?.sharedStorage(owner);
      if (identity === undefined) return;
      sharedIdentity?.(identity, suffix as AmbientProjection);
      const captures = readCaptures.slice(offset);
      const signature = JSON.stringify([
        suffix,
        copySelection === undefined ? [] : [copySelection],
        captures.map((capture) => {
          if (capture === undefined) return null;
          let id = storageCaptureIds.get(capture);
          if (id === undefined) {
            id = nextStorageCaptureId++;
            storageCaptureIds.set(capture, id);
          }
          return id;
        }),
      ]);
      const expanded = expandedStorage.get(identity) ?? new Set<string>();
      if (expanded.has(signature)) return;
      expanded.add(signature);
      expandedStorage.set(identity, expanded);
      followStores(identity, suffix, captures, [], copySelection);
    };
    const retain = (
      path: SemanticFunctionValueProjection,
      readCaptures: AmbientCaptures = [],
      copySelection?: string | null,
    ) => {
      let canonical = canonicalAmbientPath(path);
      if (hasInternalSelector(canonical)) {
        for (const identity of semanticPossibleFunctionValueIdentities(
          canonical,
        ))
          retain(identity, readCaptures, copySelection);
        return;
      }
      for (;;) {
        result.set(JSON.stringify(canonical), canonical as AmbientPath);
        if (
          possibleWrites &&
          canonical.length === 1 &&
          canonical[0] === "global"
        )
          selectStorage(canonical, 1, ["global"], [], copySelection);
        if (possibleWrites)
          for (const identity of semanticPossibleFunctionValueIdentities(
            canonical,
            (storage, offset, owner, publishNominal) => {
              const sourceCaptures: AmbientCaptures = [
                ...Array<t.Node | undefined>(
                  Math.max(0, canonical.length - readCaptures.length),
                ).fill(undefined),
                ...readCaptures,
              ].slice(-canonical.length);
              selectStorage(
                storage,
                offset,
                owner,
                sourceCaptures,
                copySelection,
              );
              if (publishNominal && !hasInternalSelector(storage))
                result.set(JSON.stringify(storage), storage as AmbientPath);
            },
          ))
            if (!result.has(JSON.stringify(identity)))
              retain(identity, readCaptures, copySelection);
        if (
          possibleWrites &&
          canonical[0] === "global" &&
          canonical[2] === "prototype" &&
          canonical[3] === "constructor"
        ) {
          canonical = ["global", canonical[1] ?? null, ...canonical.slice(4)];
          continue;
        }
        // An unknown key may select a global self reference as well as a
        // distinct property. Retain both possible object identities for writes.
        if (
          !possibleWrites ||
          canonical[0] !== "global" ||
          canonical[1] !== null
        )
          break;
        canonical = canonicalAmbientPath(["global", ...canonical.slice(2)]);
      }
    };
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const { root, members } =
        current.constructed !== undefined
          ? { root: current.node, members: [] }
          : current.binding === undefined
            ? electronMemberPath(current.node)
            : { root: current.node, members: [] };
      let suffix: AmbientSelectionProjection =
        current.suffix === undefined
          ? undefined
          : [...members, ...current.suffix];
      let captures: AmbientCaptures = [
        ...members.map(() => current.node),
        ...current.captures,
      ];
      let ownOnly = shiftedOwnOnly(current.ownOnly ?? [], members.length);
      const localRoot = current.constructed?.identity ?? root;
      let expansionKey: object = localRoot;
      if (current.capturedPrototype !== undefined) {
        let nodes = prototypeExpansions.get(current.capturedPrototype);
        if (nodes === undefined) {
          nodes = new WeakMap();
          prototypeExpansions.set(current.capturedPrototype, nodes);
        }
        const modes = nodes.get(root) ?? new Map<boolean, object>();
        const mode = current.inheritedMember === true;
        expansionKey = modes.get(mode) ?? {};
        modes.set(mode, expansionKey);
        nodes.set(root, modes);
      }
      const selectionKind =
        (suffix?.includes(SEMANTIC_PHYSICAL_PROTOTYPE) ? 1 : 0) |
        (suffix?.includes(SEMANTIC_SOURCE_PROTO_DESCRIPTOR) ? 2 : 0);
      const bySelection =
        expanded.get(expansionKey) ??
        new Map<number, Map<string | null | undefined, Expansion>>();
      const byCopy =
        bySelection.get(selectionKind) ??
        new Map<string | null | undefined, Expansion>();
      const earlier = byCopy.get(current.copySelection);
      if (earlier !== undefined) {
        const previous = earlier.suffix;
        if (previous === undefined) continue;
        if (suffix !== undefined && previous.length === suffix.length) {
          const joined: SemanticFunctionValueProjection = previous.map(
            (key, index) => (key === suffix?.[index] ? key : null),
          );
          const previousOwnOnly = earlier.ownOnly;
          ownOnly = previousOwnOnly.filter((slot) => ownOnly.includes(slot));
          const previousCaptures = earlier.captures;
          const joinedCaptures = joined.map((_, index) =>
            captures[index] === previousCaptures[index]
              ? captures[index]
              : undefined,
          );
          if (
            ownOnly.length === previousOwnOnly.length &&
            joined.every((key, index) => key === previous[index]) &&
            joinedCaptures.every(
              (site, index) => site === previousCaptures[index],
            )
          )
            continue;
          suffix = joined;
          captures = joinedCaptures;
        } else {
          suffix = undefined;
          ownOnly = [];
        }
        if (!possibleWrites) {
          cached.set(node, []);
          return [];
        }
      }
      byCopy.set(current.copySelection, { suffix, captures, ownOnly });
      bySelection.set(selectionKind, byCopy);
      expanded.set(expansionKey, bySelection);
      // A widened projection is a possible write, never proof of an intrinsic.
      if (suffix === undefined && !possibleWrites) continue;
      const continueWith = (
        node: t.Node,
        path: AmbientSelectionProjection = suffix,
        readCaptures: AmbientCaptures = captures,
        ownSlots = shiftedOwnOnly(
          ownOnly,
          readCaptures.length - captures.length,
        ),
        capturedPrototype:
          | SemanticConstructedReceiver
          | null
          | undefined = current.capturedPrototype,
        inheritedMember = current.inheritedMember,
      ) =>
        pending.push({
          node,
          suffix: path,
          captures: readCaptures,
          ownOnly: ownSlots,
          copySelection: current.copySelection,
          ...(current.readsAtSelf && { readsAtSelf: true }),
          ...(capturedPrototype == null
            ? {}
            : { capturedPrototype, inheritedMember }),
        });
      const continueCaptured = (
        node: t.Node,
        path: AmbientSelectionProjection = suffix,
        readCaptures: AmbientCaptures = captures,
      ) =>
        pending.push({
          node,
          suffix: path,
          captures: readCaptures,
          ownOnly: shiftedOwnOnly(
            ownOnly,
            readCaptures.length - captures.length,
          ),
          copySelection: current.copySelection,
          readsAtSelf: true,
        });
      const continueReturned = (
        callee: t.Node,
        path: AmbientSelectionProjection,
        readCaptures: AmbientCaptures = captures,
      ) => {
        for (const source of returnedReferences(callee))
          continueWith(
            source.node,
            path === undefined
              ? undefined
              : [
                  ...source.projection.map((key) =>
                    key === null || typeof key === "object"
                      ? null
                      : String(key),
                  ),
                  ...path,
                ],
            [...source.projection.map(() => source.node), ...readCaptures],
          );
      };
      if (possibleWrites && t.isFunction(root))
        retain([...semanticCallableValueIdentity(root), ...(suffix ?? [])]);
      const constructedPhysical =
        current.constructed !== undefined &&
        suffix?.[0] === SEMANTIC_PHYSICAL_PROTOTYPE;
      let replacement: SemanticIterationSource | undefined;
      let prototypeReplacement: SemanticIterationSource | undefined;
      let capturedPrototypeReplaced = false;
      if (
        current.constructed !== undefined ||
        (!t.isIdentifier(root) && facts?.freshObject(root))
      ) {
        if (
          !hasInternalSelector(suffix) &&
          !(current.capturedPrototype !== undefined && current.inheritedMember)
        ) {
          // A pending copied slot reads the source container; the copy owns
          // that slot. Keep its dependency without publishing the source as
          // the recipient. Consuming the slot still selects its child owner.
          // Unknown-depth selections keep their possible recipient identity.
          if (suffix !== undefined && ownOnly.length !== 0)
            localStorageRead?.(
              localRoot,
              suffix as AmbientProjection,
              captures,
            );
          else
            localIdentity?.(localRoot, suffix as AmbientProjection, captures);
        }
        ({ replacement, prototypeReplacement, capturedPrototypeReplaced } =
          followStores(
            localRoot,
            suffix,
            captures,
            ownOnly,
            current.copySelection,
            current,
            root,
          ));
      }
      if (current.constructed !== undefined) {
        const receiver = current.constructed;
        const values = constructedValues.get(receiver.identity) ?? new Set();
        values.add(receiver);
        constructedValues.set(receiver.identity, values);
        if (suffix?.length === 0) continue;
        if (constructedPhysical) {
          if (!receiver.prototypeSourceLocal)
            for (const identity of semanticUnknownReferenceIdentities())
              retain(identity);
          else
            continueWith(
              receiver.prototypeSource,
              ["prototype", ...suffix!.slice(1)],
              [receiver.allocation, ...captures.slice(1)],
              shiftedOwnOnly(ownOnly, -1),
              receiver,
              false,
            );
          continue;
        }
        const selector = suffix?.[0];
        const key = propertySelector(selector);
        let ownField = false;
        for (const field of [...receiver.fields].reverse()) {
          if (key != null && field.key !== null && field.key !== key) continue;
          if (field.value !== null)
            continueWith(field.value, suffix?.slice(1), captures.slice(1));
          if (typeof key === "string" && field.key === key && field.own) {
            ownField =
              facts?.ownSlotUnchanged?.(localRoot, key, captures[0] ?? root) ===
              true;
            break;
          }
        }
        const prototypes = functionReferences(receiver.prototypeSource).filter(
          ({ projection }) => projection.length === 0,
        );
        const storedOwn = [...(facts?.stores.get(localRoot) ?? [])].filter(
          ([source, path]) =>
            path?.length === 1 &&
            path[0] === key &&
            source.target !== undefined &&
            t.isAssignmentExpression(source.mutation, { operator: "=" }),
        );
        const ownStore =
          key === "constructor" &&
          facts?.freshObject(receiver.prototypeSource) === true &&
          prototypes.length > 0 &&
          prototypes.every(
            ({ node }) =>
              facts?.ownSlotUnchanged?.(
                node,
                "prototype",
                receiver.allocation,
              ) === true &&
              facts?.constructorPrototypeUnchanged?.(
                node,
                captures[0] ?? root,
              ) === true,
          ) &&
          facts?.ownSlotUnchanged?.(
            localRoot,
            key,
            captures[0] ?? root,
            undefined,
            new Set(storedOwn.map(([source]) => source.mutation)),
          ) === true &&
          storedOwn.some(([source]) =>
            semanticMutationPrecedesLexicalRead(
              source.mutation,
              captures[0] ?? root,
              state.parentsByNode,
            ),
          );
        if (ownStore)
          for (const [source] of storedOwn) facts?.ownReferenceStored?.(source);
        if (ownField || ownStore) continue;
        if (ownOnly.includes(0)) continue;
        if (!receiver.prototypeSourceLocal) {
          // Unmodelled constructor factories and bound newTargets cannot
          // justify intact inherited helpers. Keep their result uncertain.
          for (const identity of semanticUnknownReferenceIdentities())
            retain(identity);
          continue;
        }
        const nativePrototype = selector === "__proto__";
        const inherited: AmbientSelectionProjection =
          suffix === undefined
            ? undefined
            : ["prototype", ...(nativePrototype ? suffix.slice(1) : suffix)];
        continueWith(
          receiver.prototypeSource,
          inherited,
          [
            receiver.allocation,
            ...(nativePrototype ? captures.slice(1) : captures),
          ],
          shiftedOwnOnly(ownOnly, nativePrototype ? 0 : 1),
          receiver,
          !nativePrototype,
        );
        if (nativePrototype)
          // A user descriptor on the prototype can shadow the native accessor.
          continueWith(
            receiver.prototypeSource,
            [
              "prototype",
              SEMANTIC_SOURCE_PROTO_DESCRIPTOR,
              ...suffix!.slice(1),
            ],
            [receiver.allocation, ...captures],
            shiftedOwnOnly(ownOnly, 1),
            receiver,
            true,
          );
        continue;
      }
      if (
        t.isMetaProperty(root) &&
        root.meta.name === "import" &&
        root.property.name === "meta"
      ) {
        retain(
          ["import-meta", ...(suffix ?? [])],
          captures,
          current.copySelection,
        );
        continue;
      }
      if (possibleWrites && t.isThisExpression(root)) {
        if (receiverReferences.unknown(root).length > 0)
          for (const identity of semanticUnknownReferenceIdentities())
            retain(identity);
        for (const receiver of receiverReferences.constructed(root))
          pending.push({
            node: receiver.allocation,
            suffix,
            captures,
            constructed: receiver,
          });
        for (const receiver of receiverReferences(root))
          if (t.isProgram(receiver))
            retain(
              ["global", ...(suffix ?? [])],
              captures,
              current.copySelection,
            );
          else
            pending.push({
              node: receiver,
              suffix,
              captures,
              ownOnly,
              copySelection: current.copySelection,
              readsAtSelf: true,
            });
        continue;
      }
      if (possibleWrites) {
        const completion = receiverReferences.completion(root);
        if (completion !== undefined) {
          if (completion.unknown.length > 0)
            for (const identity of semanticUnknownReferenceIdentities())
              retain(identity);
          for (const receiver of completion.receivers)
            pending.push({
              node: receiver.allocation,
              suffix,
              captures,
              ownOnly,
              constructed: receiver,
            });
          if (completion.complete) {
            for (const source of completion.sources)
              continueReturned(source, suffix);
            continue;
          }
        }
      }
      if (
        current.capturedPrototype !== undefined &&
        !capturedPrototypeReplaced &&
        (t.isFunction(root) || t.isClass(root)) &&
        suffix?.[0] === "prototype" &&
        suffix[1] === "constructor"
      )
        continueWith(
          root,
          suffix.slice(2),
          captures.slice(2),
          shiftedOwnOnly(ownOnly, -2),
          null,
          false,
        );
      const classKey = propertySelector(suffix?.[0]);
      const classRead = captures[0];
      const classSlot =
        possibleWrites &&
        t.isClass(root) &&
        typeof classKey === "string" &&
        classKey !== "prototype"
          ? staticClassSlots(root, classKey, classRead)
          : undefined;
      for (const value of classSlot?.values ?? [])
        continueWith(value, suffix?.slice(1), captures.slice(1));
      const ownClassSlot =
        classSlot?.ownLocal === true &&
        typeof classKey === "string" &&
        classRead !== undefined &&
        classSlot.owners.every(
          (owner, index) =>
            facts?.ownSlotUnchanged?.(owner, classKey, classRead) === true &&
            // Inherited selection also depends on every crossed prototype
            // link. The declaring owner's own slot needs no such proof.
            (index === classSlot.owners.length - 1 ||
              facts?.ownSlotUnchanged?.(owner, "__proto__", classRead) ===
                true),
        );
      if (
        !ownClassSlot &&
        prototypeReplacement === undefined &&
        classSlot?.inherited != null &&
        suffix?.[0] !== "__proto__"
      )
        continueWith(classSlot.inherited, suffix, captures);
      const literalSources = t.isObjectExpression(root)
        ? semanticLiteralObjectReferenceSources(root)
        : undefined;
      const literalPrototype = possibleWrites
        ? literalSources?.prototype
        : undefined;
      const literalPrototypeKind =
        literalPrototype === undefined
          ? "primitive"
          : prototypeKind(literalPrototype);
      const defaultObjectPrototype =
        prototypeReplacement === undefined &&
        (literalPrototype === undefined ||
          literalPrototypeKind === "primitive" ||
          literalPrototypeKind === "unknown");
      const selector = suffix?.[0];
      const selectedKey = propertySelector(selector);
      const ownIntact =
        typeof selectedKey === "string" &&
        captures[0] !== undefined &&
        ownSourceSlotPresent(root, [selectedKey], captures[0]);
      if (
        possibleWrites &&
        replacement === undefined &&
        typeof selectedKey === "string" &&
        captures[0] !== undefined &&
        sourceFacts.selectedOwnSlot(root, selectedKey, captures[0])?.status ===
          "unknown"
      )
        for (const identity of semanticUnknownReferenceIdentities())
          retain(identity);
      if (
        possibleWrites &&
        t.isObjectExpression(root) &&
        suffix !== undefined &&
        (selector === SEMANTIC_PHYSICAL_PROTOTYPE ||
          (selector === "__proto__" &&
            !ownOnly.includes(0) &&
            semanticNativePrototypeGetterPossible(
              root,
              captures[0],
              state,
              sourceFacts,
              syntaxReferences,
            )))
      ) {
        if (
          literalPrototype !== undefined &&
          prototypeReplacement === undefined &&
          literalPrototypeKind !== "null" &&
          literalPrototypeKind !== "primitive"
        )
          continueWith(literalPrototype, suffix.slice(1), captures.slice(1));
        if (defaultObjectPrototype)
          retain(["global", "Object", "prototype", ...suffix.slice(1)]);
        // A physical operation never selects an own member named __proto__.
        if (selector === SEMANTIC_PHYSICAL_PROTOTYPE) continue;
      }
      if (
        possibleWrites &&
        literalPrototype !== undefined &&
        prototypeReplacement === undefined &&
        !ownOnly.includes(0) &&
        (suffix === undefined || suffix.length > 0) &&
        !ownIntact
      ) {
        // Native lookup above retained the original receiver. Continue only
        // source descriptors while crossing its prototypes.
        continueWith(
          literalPrototype,
          selector === "__proto__"
            ? [SEMANTIC_SOURCE_PROTO_DESCRIPTOR, ...suffix!.slice(1)]
            : suffix,
        );
      }
      if (
        possibleWrites &&
        (t.isFunction(root) || t.isClass(root)) &&
        prototypeReplacement === undefined &&
        !ownClassSlot &&
        !ownOnly.includes(0) &&
        !capturedPrototypeReplaced &&
        !(
          current.capturedPrototype !== undefined &&
          t.isClass(root) &&
          t.isNullLiteral(root.superClass) &&
          suffix?.[0] === "prototype" &&
          (suffix[1] === "__proto__" ||
            suffix[1] === SEMANTIC_PHYSICAL_PROTOTYPE)
        )
      ) {
        // A derived class inherits its constructor prototype from its base,
        // rather than directly from Function.prototype.
        if (
          t.isClass(root) &&
          root.superClass != null &&
          !t.isNullLiteral(unwrapJavaScriptExpression(root.superClass).node) &&
          (suffix?.[0] === "__proto__" ||
            suffix?.[0] === SEMANTIC_PHYSICAL_PROTOTYPE)
        )
          continueWith(root.superClass, suffix.slice(1), captures.slice(1));
        else
          for (const identity of semanticSourceFunctionValueIdentities(
            root,
            suffix ?? [null],
            false,
            (storage, offset, owner) =>
              selectStorage(
                storage,
                offset,
                owner,
                captures,
                current.copySelection,
              ),
          ))
            retain(identity, captures, current.copySelection);
      }
      if (
        possibleWrites &&
        suffix !== undefined &&
        (typeof suffix[0] === "string" ||
          suffix[0] === SEMANTIC_PHYSICAL_PROTOTYPE) &&
        !ownOnly.includes(0) &&
        ((t.isObjectExpression(root) && !ownIntact && defaultObjectPrototype) ||
          (t.isArrayExpression(root) &&
            suffix[0] !== "length" &&
            (suffix[0] === SEMANTIC_PHYSICAL_PROTOTYPE ||
              semanticArrayIndex(suffix[0]) === null)))
      )
        for (const identity of semanticLiteralInheritedValueIdentities(
          t.isArrayExpression(root) ? "array" : "object",
          suffix,
          (storage, offset, owner) =>
            selectStorage(
              storage,
              offset,
              owner,
              captures,
              current.copySelection,
            ),
        ))
          retain(identity, captures, current.copySelection);
      if (
        possibleWrites &&
        suffix !== undefined &&
        classSlot?.own !== true &&
        replacement === undefined &&
        prototypeReplacement === undefined &&
        !hasInternalSelector(suffix) &&
        !ownOnly.includes(0) &&
        !capturedPrototypeReplaced &&
        !(
          current.capturedPrototype !== undefined &&
          t.isClass(root) &&
          t.isNullLiteral(root.superClass) &&
          suffix?.[0] === "prototype" &&
          suffix[1] === "__proto__"
        ) &&
        (t.isObjectExpression(root) ||
          t.isClass(root) ||
          t.isNewExpression(root))
      )
        // One projection walk avoids retaining every prefix of helper chains.
        for (const { node: target, projection } of functionReferences(
          root,
          suffix as AmbientPath,
        )) {
          const remaining = projection.map((key) =>
            key === null ? null : String(key),
          );
          for (const identity of semanticSourceFunctionValueIdentities(
            target,
            remaining,
            false,
            (storage, offset, owner) =>
              selectStorage(
                storage,
                offset,
                owner,
                captures,
                current.copySelection,
              ),
          ))
            retain(identity, captures, current.copySelection);
        }
      if (current.binding !== undefined || t.isIdentifier(root)) {
        // The wrapper module object is distinct from globalThis.module. Keep
        // its identity through the same alias/projection owner used for writes.
        if (
          current.binding === undefined &&
          isUnshadowedGlobal(root, state, "module")
        ) {
          retain(
            ["commonjs-module", ...(suffix ?? [])],
            captures,
            current.copySelection,
          );
          continue;
        }
        if (
          current.binding === undefined &&
          globalObjectName(root, state) !== undefined
        ) {
          const rootReplacement = t.isIdentifier(root)
            ? facts?.globalRootReplacement?.(root.name, root)
            : undefined;
          const member = suffix?.[0];
          const memberReplacement =
            typeof member === "string" && captures[0] !== undefined
              ? facts?.globalRootReplacement?.(member, captures[0])
              : undefined;
          if (rootReplacement !== undefined)
            continueCaptured(rootReplacement.node);
          else if (memberReplacement !== undefined)
            continueCaptured(
              memberReplacement.node,
              suffix?.slice(1),
              captures.slice(1),
            );
          else
            retain(
              ["global", ...(suffix ?? [])],
              captures,
              current.copySelection,
            );
          continue;
        }
        if (
          current.binding === undefined &&
          t.isIdentifier(root) &&
          isUnshadowedGlobal(root, state, root.name)
        ) {
          const replacement = facts?.globalRootReplacement?.(root.name, root);
          if (replacement !== undefined) continueCaptured(replacement.node);
          else
            retain(
              ["global", root.name, ...(suffix ?? [])],
              captures,
              current.copySelection,
            );
          continue;
        }
        const binding =
          current.binding ??
          (t.isIdentifier(root)
            ? resolveSemanticBindingState(state, root, root.name)
            : undefined);
        if (binding === undefined) continue;
        const stable = semanticStableInitializer(binding, state);
        const readAt = current.readsAtSelf ? root : capture;
        const selected =
          possibleWrites && readAt !== undefined
            ? semanticBindingAtRead(binding, readAt, state.parentsByNode)
                .binding
            : binding;
        if (possibleWrites)
          for (const origin of selected.directOrigins)
            for (const path of builtinValuePaths(origin, suffix))
              retain(path, captures, current.copySelection);
        const initializers = possibleWrites
          ? selected.initializers
          : stable === undefined
            ? []
            : [stable];
        if (possibleWrites)
          for (const initializer of selected.referenceInitializers) {
            if (
              semanticReferenceSourcesInactive(
                initializer,
                state,
                "syntax-only",
              )
            )
              continue;
            if (
              initializer.copyProjectionOffset !== undefined &&
              suffix?.[0] === SEMANTIC_PHYSICAL_PROTOTYPE
            ) {
              retain([
                "global",
                initializer.copyKind === "array-rest" ? "Array" : "Object",
                "prototype",
                ...suffix.slice(1),
              ]);
              continue;
            }
            if (
              initializer.copyKind === "object-rest" &&
              !ownOnly.includes(0) &&
              suffix !== undefined &&
              typeof suffix[0] === "string"
            ) {
              const ownPath = semanticCopiedReferencePath(
                initializer,
                [suffix[0]],
                "reference",
              );
              if (
                ownPath === null ||
                !ownSourceSlotPresent(
                  initializer.node,
                  ownPath.map((key) =>
                    key === null || typeof key === "object"
                      ? null
                      : String(key),
                  ),
                  initializer.node,
                )
              )
                for (const identity of semanticLiteralInheritedValueIdentities(
                  "object",
                  suffix,
                ))
                  retain(identity);
            }
            const internalOffset =
              suffix?.findIndex((key) => typeof key === "symbol") ?? -1;
            const publicPrefix =
              suffix === undefined
                ? [null]
                : internalOffset < 0
                  ? suffix
                  : suffix.slice(0, internalOffset);
            const copied = semanticCopiedReferencePath(
              initializer,
              publicPrefix as AmbientPath,
              escapedContents ? "escape" : "reference",
            );
            if (copied === null) continue;
            const path = [
              ...copied,
              ...(internalOffset < 0 ? [] : suffix!.slice(internalOffset)),
            ];
            const referenceCaptures = [
              ...initializer.projection.map(() => initializer.node),
              ...captures,
            ];
            const offset = initializer.copyProjectionOffset;
            if (offset !== undefined) {
              referenceCaptures.splice(offset, 1);
              referenceCaptures[offset] = initializer.node;
            }
            pending.push({
              node: initializer.node,
              readsAtSelf: true,
              captures: referenceCaptures,
              ownOnly: [
                ...shiftedOwnOnly(
                  ownOnly,
                  initializer.projection.length -
                    (offset === undefined ? 0 : 1),
                ),
                ...(offset !== undefined &&
                initializer.copyKind === "object-rest"
                  ? [offset]
                  : []),
              ],
              suffix: path.map((key) =>
                typeof key === "symbol"
                  ? key
                  : key === null || typeof key === "object"
                    ? null
                    : String(key),
              ),
            });
          }
        for (const initializer of initializers)
          pending.push({
            node: initializer.node,
            ...(current.capturedPrototype === undefined
              ? {}
              : {
                  capturedPrototype: current.capturedPrototype,
                  inheritedMember: current.inheritedMember,
                }),
            readsAtSelf: true,
            ownOnly: shiftedOwnOnly(ownOnly, initializer.projection.length),
            copySelection: current.copySelection,
            captures: [
              ...initializer.projection.map(() => initializer.node),
              ...captures,
            ],
            suffix:
              suffix === undefined
                ? undefined
                : [
                    ...initializer.projection.map((key) =>
                      key === null ? null : String(key),
                    ),
                    ...suffix,
                  ],
          });
        continue;
      }
      if (
        possibleWrites &&
        t.isNewExpression(root) &&
        (suffix?.[0] === "__proto__" ||
          suffix?.[0] === SEMANTIC_PHYSICAL_PROTOTYPE ||
          suffix?.[0] === "constructor")
      ) {
        continueWith(
          root.callee,
          suffix[0] === "__proto__" || suffix[0] === SEMANTIC_PHYSICAL_PROTOTYPE
            ? ["prototype", ...suffix.slice(1)]
            : suffix.slice(1),
          suffix[0] === "__proto__" || suffix[0] === SEMANTIC_PHYSICAL_PROTOTYPE
            ? captures
            : captures.slice(1),
        );
        continue;
      }
      const prototypeTarget = possibleWrites
        ? facts?.prototypeTarget(root)
        : undefined;
      if (prototypeTarget !== undefined) {
        continueWith(
          prototypeTarget,
          suffix === undefined
            ? undefined
            : [SEMANTIC_PHYSICAL_PROTOTYPE, ...suffix],
          [root, ...captures],
        );
        continue;
      }
      if (
        possibleWrites &&
        (t.isCallExpression(root) || t.isOptionalCallExpression(root))
      ) {
        for (const source of intrinsics.callReferenceSources(
          root,
          suffix,
          escapedContents,
        ))
          continueCaptured(
            source.node,
            source.projection,
            captures.slice(source.projectionOffset),
          );
        const bound = functionInterop.boundIntrinsic(root);
        const allocation = bound?.boundFunction?.allocations[0];
        if (allocation !== undefined)
          retain([
            ...semanticCallableValueIdentity(allocation),
            ...(suffix ?? []),
          ]);
        if (
          (suffix === undefined || suffix.length > 0) &&
          prototypeReplacement === undefined
        ) {
          if (bound?.path[1] === "source-function" && bound.path.length === 3) {
            for (const target of functionGroups.get(bound.path[2]!) ?? []) {
              if (
                t.isClass(target) &&
                target.superClass != null &&
                !t.isNullLiteral(
                  unwrapJavaScriptExpression(target.superClass).node,
                ) &&
                (suffix?.[0] === "__proto__" ||
                  suffix?.[0] === SEMANTIC_PHYSICAL_PROTOTYPE)
              )
                continueWith(
                  target.superClass,
                  suffix.slice(1),
                  captures.slice(1),
                );
              else
                for (const identity of semanticSourceFunctionValueIdentities(
                  target,
                  suffix ?? [null],
                  true,
                  (storage, offset, owner) =>
                    selectStorage(
                      storage,
                      offset,
                      owner,
                      captures,
                      current.copySelection,
                    ),
                ))
                  retain(identity, captures, current.copySelection);
            }
          } else if (
            bound !== undefined ||
            functionInterop.intrinsicInvocation(root)?.path.join(".") ===
              "intrinsic.Function"
          )
            for (const identity of semanticOrdinaryFunctionValueIdentities(
              suffix ?? [null],
              (storage, offset, owner) =>
                selectStorage(
                  storage,
                  offset,
                  owner,
                  captures,
                  current.copySelection,
                ),
            ))
              retain(identity, captures, current.copySelection);
        }
        if (
          (suffix === undefined || suffix.length > 0) &&
          semanticRequireFunctionValue(root, state)
        )
          for (const identity of semanticOrdinaryFunctionValueIdentities(
            suffix ?? [null],
            (storage, offset, owner) =>
              selectStorage(
                storage,
                offset,
                owner,
                captures,
                current.copySelection,
              ),
          ))
            retain(identity, captures, current.copySelection);
        const origin =
          semanticRequireOrigin(root, state)?.origin ??
          semanticRequireShimOrigin(root, state)?.origin;
        if (origin !== undefined)
          for (const path of builtinValuePaths(origin, suffix))
            retain(path, captures, current.copySelection);
      }
      if (
        possibleWrites &&
        t.isNewExpression(root) &&
        intrinsics.intrinsicPath(root.callee)?.join(".") ===
          "intrinsic.Function"
      )
        for (const identity of semanticOrdinaryFunctionValueIdentities(
          suffix ?? [null],
        ))
          retain(identity, captures, current.copySelection);
      if (
        possibleWrites &&
        (t.isCallExpression(root) ||
          t.isOptionalCallExpression(root) ||
          t.isNewExpression(root) ||
          t.isTaggedTemplateExpression(root) ||
          (escapedContents && (t.isFunction(root) || t.isClass(root))))
      ) {
        continueReturned(
          t.isFunction(root) || t.isClass(root)
            ? root
            : t.isTaggedTemplateExpression(root)
              ? root.tag
              : root.callee,
          suffix,
        );
        continue;
      }
      if (possibleWrites && t.isConditionalExpression(root)) {
        continueWith(root.consequent);
        continueWith(root.alternate);
        continue;
      }
      if (possibleWrites && t.isLogicalExpression(root)) {
        continueWith(root.left);
        continueWith(root.right);
        continue;
      }
      if (possibleWrites && t.isSequenceExpression(root)) {
        const value = root.expressions.at(-1);
        if (value !== undefined) continueWith(value);
        continue;
      }
      if (
        possibleWrites &&
        t.isAssignmentExpression(root) &&
        root.operator === "="
      ) {
        continueWith(root.right);
        continue;
      }
      const key = propertySelector(suffix?.[0]);
      // Container escapes reuse the finite worklist, including alias cycles.
      if (escapedContents && suffix?.length === 0) {
        if (t.isObjectExpression(root)) {
          const source = semanticLiteralObjectReferenceSources(root);
          if (source.prototype !== undefined)
            continueWith(source.prototype, []);
          for (const property of source.sources)
            if (property.kind === "data" || property.kind === "spread")
              continueWith(property.node, []);
            else if (property.kind === "get")
              continueReturned(property.node, [], []);
          continue;
        }
        if (t.isArrayExpression(root)) {
          for (const element of root.elements)
            if (t.isSpreadElement(element)) continueWith(element.argument, []);
            else if (t.isExpression(element)) continueWith(element, []);
          continue;
        }
      }
      if (suffix !== undefined && key === undefined) continue;
      if (t.isObjectExpression(root)) {
        const source = literalSources!;
        if (possibleWrites && replacement === undefined) {
          for (const property of source.sources) {
            if (property.kind === "spread")
              continueWith(
                property.node,
                suffix,
                [property.capture, ...captures.slice(1)],
                [...new Set([0, ...ownOnly])],
              );
            else if (
              property.kind === "data" ||
              property.kind === "get" ||
              property.kind === "method"
            ) {
              if (
                suffix === undefined ||
                key === null ||
                property.key === null ||
                property.key === key
              )
                if (property.kind === "get")
                  continueReturned(
                    property.node,
                    suffix?.slice(1),
                    captures.slice(1),
                  );
                else
                  continueWith(
                    property.node,
                    suffix?.slice(1),
                    captures.slice(1),
                  );
            }
          }
        } else if (
          !possibleWrites &&
          suffix !== undefined &&
          key !== null &&
          !source.unknownKeys &&
          source.sources.every((property) => property.kind === "data")
        ) {
          const property = source.properties.get(key!);
          if (property !== undefined)
            continueWith(property, suffix.slice(1), captures.slice(1));
        }
      } else if (t.isArrayExpression(root)) {
        if (suffix === undefined) {
          for (const element of root.elements)
            if (t.isSpreadElement(element)) continueWith(element.argument);
            else if (t.isExpression(element)) continueWith(element);
        } else if (!root.elements.some(t.isSpreadElement)) {
          const index = Number(key);
          if (key === null && possibleWrites) {
            for (const element of root.elements)
              if (t.isExpression(element))
                continueWith(element, suffix.slice(1), captures.slice(1));
          } else if (
            key !== null &&
            Number.isInteger(index) &&
            index >= 0 &&
            String(index) === key
          ) {
            const element = root.elements[index];
            if (t.isExpression(element))
              continueWith(element, suffix.slice(1), captures.slice(1));
          }
        }
      }
    }
    const paths = [...result.values()];
    if (!possibleWrites && initialBinding === undefined)
      cached.set(node, paths);
    return paths;
  };
  const activeDescriptorInputs = new WeakSet<t.Node>();
  return Object.assign(
    (
      node: t.Node,
      capture?: t.Node,
      escapedContents = false,
      projection: AmbientProjection = [],
      localIdentity?: (
        node: SemanticLocalIdentity,
        path: AmbientProjection,
        captures: AmbientCaptures,
      ) => void,
      sharedIdentity?: (
        owner: SemanticSharedStorageIdentity,
        path: AmbientProjection,
      ) => void,
      localStorageRead?: (
        owner: SemanticLocalIdentity,
        path: AmbientProjection,
        captures: AmbientCaptures,
      ) => void,
    ) =>
      resolve(
        node,
        capture,
        escapedContents,
        projection,
        localIdentity,
        undefined,
        sharedIdentity,
        localStorageRead,
      ),
    {
      descriptorInputObject: (input: t.Node, read: t.Node) => {
        if (activeDescriptorInputs.has(read)) return undefined;
        activeDescriptorInputs.add(read);
        try {
          const references = syntaxReferences(input, [], read);
          if (!references.complete || references.nodes.length !== 1)
            return undefined;
          const owner = references.nodes[0];
          if (
            !t.isObjectExpression(owner) ||
            facts?.prototypeUnchanged?.(owner, read) !== true ||
            [
              "enumerable",
              "configurable",
              "value",
              "writable",
              "get",
              "set",
            ].some(
              (key) =>
                facts.ownSlotUnchanged?.(owner, key, read) !== true ||
                (staticObjectOwnProperty(owner, key).status === "missing" &&
                  !nativePrototypeDescriptorIntact("Object", read, key)),
            )
          )
            return undefined;
          return owner;
        } finally {
          activeDescriptorInputs.delete(read);
        }
      },
      nativePrototypeGetterPossible: (owner: t.Node, read: t.Node) =>
        semanticNativePrototypeGetterPossible(
          owner,
          read,
          state,
          sourceFacts,
          syntaxReferences,
        ),
      propertySetMayInvokeUserCode: (
        owner: t.Node | undefined,
        key: string | null,
        read: t.Node,
      ): boolean | undefined => {
        const snapshot = facts?.intrinsicWriteFacts;
        if (
          facts === undefined ||
          owner === undefined ||
          key === null ||
          snapshot?.complete !== true
        )
          return true;
        // Resolve aliases, explicit returned objects and allocated receivers
        // through the same identity owner as mutation lookup.
        const local = new Map<
          SemanticLocalIdentity,
          { path: AmbientProjection; captures: AmbientCaptures }
        >();
        const ambient = resolve(
          owner,
          read,
          false,
          [],
          (root, path, captures) => {
            const previous = local.get(root);
            local.set(
              root,
              previous === undefined
                ? { path, captures }
                : {
                    path: joinAmbientProjection(previous.path, path),
                    captures: captures.map((capture, index) =>
                      capture === previous.captures[index]
                        ? capture
                        : undefined,
                    ),
                  },
            );
          },
        );
        // Unsupported nominal lookup ownership retains escape policy without
        // claiming that its descriptors exclude a user setter.
        if (
          ambient.length > 0 &&
          ambient.every(
            (path) =>
              !isSemanticUnknownReferenceIdentity(path) &&
              (!semanticSharedStorageHasDescriptorFacts(path) ||
                (path.length === 1 &&
                  !semanticGlobalRootHasDataDescriptor(key))),
          )
        )
          return undefined;
        const selected = new Set<SemanticLocalIdentity>();
        if (ambient.length === 0 && local.size > 0) {
          for (const [root, { path, captures }] of local) {
            if (path === undefined) return true;
            if (path.length === 0) {
              selected.add(root);
              continue;
            }
            if (
              isSemanticAllocatedReceiverIdentity(root) ||
              captures.some((capture) => capture === undefined)
            )
              return true;
            const references = syntaxReferences(
              root,
              path,
              read,
              false,
              captures as readonly t.Node[],
            );
            if (!references.complete) return true;
            for (const reference of references.nodes) selected.add(reference);
          }
        } else selected.add(owner);
        const owners = [...selected];
        return owners.some((owner) => {
          if (isSemanticAllocatedReceiverIdentity(owner)) {
            const receivers = constructedValues.get(owner);
            if (
              receivers === undefined ||
              facts.ownSlotUnchanged?.(owner, key, read) !== true
            )
              return true;
            return [...receivers].some((receiver) => {
              const prototypes = functionReferences(receiver.prototypeSource);
              if (
                !receiver.prototypeSourceLocal ||
                facts.freshObject(receiver.prototypeSource) !== true ||
                prototypes.length === 0
              )
                return true;
              return prototypes.some(({ node, projection }) => {
                if (
                  projection.length !== 0 ||
                  facts.ownSlotUnchanged?.(
                    node,
                    "prototype",
                    receiver.allocation,
                  ) !== true ||
                  facts.constructorPrototypeUnchanged?.(node, read) !== true
                )
                  return true;
                if (t.isClass(node)) {
                  const descriptor = semanticClassPropertyDescriptors(
                    node,
                    key,
                    "prototype",
                  );
                  if (descriptor.mayInvokeSetter) return true;
                  if (!descriptor.inherits) return false;
                  if (
                    node.superClass != null &&
                    !t.isNullLiteral(node.superClass)
                  )
                    return true;
                }
                return !nativePrototypeDescriptorIntact(
                  "Object",
                  read,
                  key,
                  true,
                );
              });
            });
          }
          return !semanticEverySourcePropertySlot(
            owner,
            key,
            read,
            state,
            {
              ...sourceFacts,
              // Descriptor lookup precedes this store's own effect. Its write
              // cannot establish an own slot or invalidate the initial slot.
              ownDescriptorIntact: (owner, key, at) =>
                sourceFacts.ownDescriptorIntact(owner, key, at) ||
                facts.ownSlotUnchanged?.(owner, key, at) === true,
            },
            (slot) => {
              if (slot.kind === "missing") return true;
              if (slot.kind === "source") return !slot.mayInvokeSetter;
              if (slot.kind === "updated")
                return slot.mayInvokeSetter === false || slot.writable;
              const intrinsic =
                slot.kind === "external"
                  ? descriptorInterop.capturedIntrinsicPath(slot.node)
                  : undefined;
              if (
                intrinsic?.length === 2 &&
                ["Object", "Function", "Array", "Reflect"].includes(
                  intrinsic[1] ?? "",
                )
              )
                return (
                  nativePrototypeDescriptorIntact(
                    intrinsic[1] === "Reflect" ? "Object" : "Function",
                    read,
                    key,
                    true,
                  ) &&
                  !semanticAmbientWriteMayMatch(
                    snapshot,
                    ["global", intrinsic[1]!, key],
                    (effect) =>
                      effect.node !== read &&
                      semanticEffectTiming(read, effect.node, state) !==
                        "after",
                  )
                );
              const builtin =
                slot.kind === "ordinary-prototype"
                  ? "Object"
                  : slot.kind === "callable-prototype"
                    ? "Function"
                    : slot.kind === "external"
                      ? semanticBuiltinDataPrototypeOwner(
                          descriptorInterop.capturedIntrinsicPath(slot.node),
                        )
                      : undefined;
              return (
                builtin !== undefined &&
                nativePrototypeDescriptorIntact(builtin, read, key, true)
              );
            },
            syntaxReferences,
          );
        });
      },
      dataWritePossible: (
        owner: t.Node,
        key: string,
        read: t.Node,
        nativePrototypesIntact: boolean,
      ) =>
        semanticEverySourcePropertySlot(
          owner,
          key,
          read,
          state,
          sourceFacts,
          (slot) => {
            if (slot.kind === "missing") return true;
            if (slot.kind === "updated") return slot.writable;
            if (slot.kind === "source")
              return (
                slot.unchanged &&
                (t.isObjectProperty(slot.property) ||
                  slot.property.kind === "method")
              );
            if (!nativePrototypesIntact || key === "__proto__") return false;
            if (slot.kind === "ordinary-prototype") return true;
            if (slot.kind === "callable-prototype")
              return semanticBuiltinPrototypeDataWritePossible(
                ["intrinsic", "Function", "prototype"],
                key,
              );
            if (
              slot.kind !== "external" ||
              facts?.intrinsicWriteFacts?.complete !== true
            )
              return false;
            return semanticBuiltinPrototypeDataWritePossible(
              descriptorInterop.capturedIntrinsicPath(slot.node),
              key,
            );
          },
          syntaxReferences,
        ),
      prototypeSlotAssignmentPreservesOwnDescriptors: (
        owner: t.Node,
        site: t.Node,
        nativePrototypesIntact: boolean,
      ) => prototypeAssignment(owner, site, nativePrototypesIntact, true),
      nativePrototypeAssignmentChangesLink: (
        owner: t.Node,
        site: t.Node,
        nativePrototypesIntact: boolean,
      ) => prototypeAssignment(owner, site, nativePrototypesIntact, false),
      referenceAssignmentIsBlocked: (
        receiver: t.Node,
        key: string,
        read: t.Node,
      ) =>
        semanticEverySourcePropertySlot(
          receiver,
          key,
          read,
          state,
          sourceFacts,
          (slot) =>
            slot.kind === "source" &&
            slot.unchanged &&
            t.isObjectMethod(slot.property, { kind: "get" }) &&
            !slot.mayInvokeSetter,
          syntaxReferences,
        ),
      prototypeKind,
      binding: (binding: JavaScriptSemanticBindingState, capture: t.Node) =>
        resolve(capture, capture, true, [], undefined, binding),
    },
  );
};

const completedAmbientResolvers = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ReturnType<typeof createAmbientPathResolver>
>();

interface AmbientEscapeEffect {
  readonly node: t.Node;
  readonly path: AmbientPath;
}

const completedAmbientEscapeEffects = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly AmbientEscapeEffect[]
>();

/** Final escape paths retain their sites for consumers with capture timing. */
export const semanticAmbientEscapeEffects = (
  state: JavaScriptSemanticAnalysisState,
): readonly AmbientEscapeEffect[] | undefined =>
  completedAmbientEscapeEffects.get(state);

type OwnSlotUnchanged = NonNullable<AmbientReferenceFacts["ownSlotUnchanged"]>;
const completedOwnSlots = new WeakMap<
  JavaScriptSemanticAnalysisState,
  OwnSlotUnchanged
>();

/** Slot captures become provable before the final ambient writes are published. */
export const semanticAmbientOwnSlotFactsReady = (
  state: JavaScriptSemanticAnalysisState,
): boolean => completedOwnSlots.has(state);

/** Strict local capture uses the same completed store and escape snapshot. */
export const semanticAmbientOwnSlotUnchanged = (
  state: JavaScriptSemanticAnalysisState,
  owner: SemanticLocalIdentity,
  key: string,
  read: t.Node,
  since?: t.Node,
  acceptedWrites?: ReadonlySet<t.Node>,
): boolean =>
  completedOwnSlots.get(state)?.(owner, key, read, since, acceptedWrites) ===
  true;

export const semanticAmbientIdentitySourcesReady = (
  state: JavaScriptSemanticAnalysisState,
): boolean => completedAmbientResolvers.has(state);

/** Opaque lexical consumers use the same possible reference graph as writes. */
export const semanticAmbientBindingPaths = (
  binding: JavaScriptSemanticBindingState,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly AmbientPath[] =>
  (
    completedAmbientResolvers.get(state) ??
    createAmbientPathResolver(state, true)
  ).binding(binding, capture);

/** Each slot keeps its own capture when shared Module owners are normalized. */
export type SemanticModuleProjection = readonly {
  readonly key: string | number | null;
  readonly capture: t.Node;
}[];

/** Source stores can replace a Module property with the wrapper itself. Reads
 * and writes use the same nominal storage owner, without proving a loader.
 * The require-write cache recreates this query when ambient/fresh facts change. */
export const createSemanticModuleStorageQuery = (
  state: JavaScriptSemanticAnalysisState,
  interop: ReturnType<typeof createSemanticModuleInterop>,
) => {
  type Write = {
    node: t.Node;
    path: AmbientPath;
    sources: readonly SemanticIterationSource[];
  };
  let writes: Write[] | undefined;
  return (projection: SemanticModuleProjection): boolean => {
    if (writes === undefined) {
      const collected: Write[] = [];
      writes = collected;
      const paths = createAmbientPathResolver(state, true);
      const sources = new WeakMap<t.Node, readonly SemanticIterationSource[]>();
      const targets = new WeakMap<
        SemanticIterationSource,
        ReadonlySet<string>
      >();
      completeSemanticSteps(
        collectJavaScriptIdentityWritesSteps(
          state.program,
          (node, kind, site) => (kind === "member" ? paths(node, site) : []),
          interop.intrinsicInvocation,
          interop.staticString,
          interop.isFreshObject,
          (node, path) => {
            if (path[0] !== "commonjs-module") return;
            let references = sources.get(node);
            if (references === undefined) {
              references = semanticIterationSources(
                node,
                state.parentsByNode.get(node) ?? null,
              ).filter((source) => source.kind === "reference-store");
              sources.set(node, references);
            }
            const selected = references.filter((source) => {
              if (source.target === undefined) return false;
              let stored = targets.get(source);
              if (stored === undefined) {
                const key = semanticStaticPropertyKey(
                  source.target.property,
                  source.target.computed,
                );
                stored = new Set(
                  paths(source.target.object, source.mutation).map((owner) =>
                    JSON.stringify([...owner, key]),
                  ),
                );
                targets.set(source, stored);
              }
              return stored.has(JSON.stringify(path));
            });
            collected.push({ node, path, sources: selected });
          },
        ),
      );
    }
    const nominal: AmbientPath = [
      "commonjs-module",
      ...projection.map(({ key }) => (key === null ? null : String(key))),
    ];
    const captures: AmbientCaptures = [
      undefined,
      ...projection.map(({ capture }) => capture),
    ];
    const reads = new Map<
      string,
      { path: AmbientPath; captures: AmbientCaptures }
    >([[JSON.stringify(nominal), { path: nominal, captures }]]);
    semanticPossibleFunctionValueIdentities(
      nominal,
      (path, offset, _owner, publishNominal) => {
        if (!publishNominal || hasInternalSelector(path)) return;
        const suffix = captures.slice(offset);
        reads.set(JSON.stringify(path), {
          path: path as AmbientPath,
          captures: [
            ...Array<t.Node | undefined>(path.length - suffix.length).fill(
              captures[offset - 1],
            ),
            ...suffix,
          ],
        });
      },
    );
    return [...reads.values()].some((read) =>
      writes!.some(({ node, path, sources }) => {
        const capture = read.captures[path.length - 1];
        if (
          capture === undefined ||
          path.length > read.path.length ||
          !path.every(
            (key, index) =>
              key === null ||
              read.path[index] === null ||
              key === read.path[index],
          ) ||
          semanticEffectTiming(capture, node, state) === "after"
        )
          return false;
        if (sources.length === 0) return true;
        return sources.some(
          (source) =>
            !semanticReferenceSourcesInactive(source, state, "syntax-only") &&
            !(
              path.length === read.path.length &&
              source.projection.length === 0 &&
              (readExactJavaScriptLiteral(source.node).found ||
                (semanticFreshObjectFactsReady(state) &&
                  interop.isFreshObject(source.node)))
            ),
        );
      }),
    );
  };
};

/** Possible inherited accessor helpers are effects, never strict call proofs. */
const createPossibleAccessorMutations = (
  state: JavaScriptSemanticAnalysisState,
  possiblePaths: ReturnType<typeof createAmbientPathResolver>,
  interop: ReturnType<typeof createSemanticModuleInterop>,
) => {
  const candidates = new WeakSet<t.Node>();
  const sources = new WeakMap<
    NonNullable<ReturnType<typeof interop.intrinsicInvocation>>,
    t.CallExpression | t.OptionalCallExpression
  >();
  const paths = new WeakMap<t.Node, readonly string[] | null>();
  const possible = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const known = interop.intrinsicPath(node);
      const prior = paths.get(node);
      if (prior !== undefined) return prior ?? known;
      for (const nominal of possiblePaths(node)) {
        for (let end = 1; end <= nominal.length; end += 1)
          for (const value of semanticPossibleFunctionValueIdentities(
            nominal.slice(0, end),
          )) {
            if (value[0] !== "global") continue;
            const path = ["intrinsic", ...value.slice(1)];
            if (
              semanticIntrinsicMutation({
                kind: "known",
                path,
                arguments: undefined,
              })?.receiver !== true
            )
              continue;
            // Typed selectors before the helper can be unknown cache keys.
            // Invocation syntax after the selected callable must stay exact.
            const suffix = nominal.slice(end);
            if (suffix.some((key) => key === null)) continue;
            const selected = [...path, ...(suffix as readonly string[])];
            paths.set(node, selected);
            return selected;
          }
      }
      paths.set(node, null);
      return known;
    },
  });
  return {
    candidates,
    sources,
    invocation: (node: t.CallExpression | t.OptionalCallExpression) => {
      const known = interop.intrinsicInvocation(node);
      if (semanticIntrinsicMutation(known) !== undefined) return known;
      const candidate = possible.intrinsicInvocation(node);
      if (semanticIntrinsicMutation(candidate)?.receiver !== true) return known;
      candidates.add(node);
      sources.set(candidate!, node);
      return candidate;
    },
  };
};

/**
 * Index source-local writes through ambient identities and stable aliases.
 * The shared invocation owner resolves intrinsic aliases, bind/call/apply and
 * literal argument spreads. Runtime reachability and arbitrary call effects
 * remain unevaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  createOpaqueObserver?: (
    paths: ReturnType<typeof createAmbientPathResolver>,
    retainGlobal?: (node: t.CallExpression | t.OptionalCallExpression) => void,
  ) => ((node: t.Node) => void) | undefined,
): Generator<void> {
  const ambientReads = createAmbientPathResolver(state, false);
  const browserReceiverMethods = new Set<string>();
  const storedSites = new WeakSet<t.Node>();
  const storedReferences: SemanticIterationSource[] = [];
  const globalRootSources = new Map<string, SemanticIterationSource[]>();
  const intrinsicStoreRecipients = new WeakMap<
    object,
    Set<t.Node | undefined>
  >();
  const replacementSources: SemanticIterationSource[] = [];
  const inertReferenceStores = new WeakSet<SemanticIterationSource>();
  const replacements = new WeakMap<
    SemanticStorageIdentity,
    Map<AmbientReplacementKey, SemanticIterationSource[]>
  >();
  const writes: {
    node: t.Node;
    path: AmbientPath;
    recipient?: JavaScriptIntrinsicMutationRecipient;
    valueOnly?: true;
  }[] = [];
  const targets: { node: t.Node; capture: t.Node }[] = [];
  const escapes: {
    node: t.Node;
    target: t.Node;
    browserReceiver: boolean;
    projection?: AmbientProjection;
    argument?: true;
  }[] = [];
  const invocationSites = new Set<
    t.CallExpression | t.OptionalCallExpression
  >();
  const stores = new WeakMap<
    SemanticStorageIdentity,
    Map<SemanticIterationSource, AmbientProjection>
  >();
  const sharedStorage = createSemanticSharedStorageIdentities();
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const [path] = ambientReads(node);
      return path?.[0] === "global" && path.every((key) => key !== null)
        ? ["intrinsic", ...(path.slice(1) as readonly string[])]
        : undefined;
    },
  });
  let ownSlotUnchanged: AmbientReferenceFacts["ownSlotUnchanged"];
  let ownDescriptorIntact: AmbientReferenceFacts["ownDescriptorIntact"];
  let prototypeUnchanged: AmbientReferenceFacts["prototypeUnchanged"];
  let ownSlotValueUnknown: AmbientReferenceFacts["ownSlotValueUnknown"];
  let constructorPrototypeUnchanged: AmbientReferenceFacts["constructorPrototypeUnchanged"];
  const storeKinds = new WeakMap<
    SemanticIterationSource,
    "prototype" | "own-data" | "own-slot"
  >();

  let globalRootReplacement: AmbientReferenceFacts["globalRootReplacement"];
  let sourceSlotsComplete = false;
  const referenceFacts: AmbientReferenceFacts = {
    stores,
    sharedStorage,
    sourceSlotsComplete: () => sourceSlotsComplete,
    globalRootReplacement: (name, read) => {
      const selected = globalRootReplacement?.(name, read);
      if (selected !== undefined) inertReferenceStores.add(selected);
      return selected;
    },
    hasGlobalRootStores: () => globalRootSources.size > 0,
    replacements,
    storeKinds,
    ownReferenceStored: (source) => inertReferenceStores.add(source),
    constructorPrototypeUnchanged: (owner, read) =>
      constructorPrototypeUnchanged?.(owner, read) === true,
    ownSlotValueUnknown: (owner, key, read) =>
      ownSlotValueUnknown?.(owner, key, read) === true,
    prototypeUnchanged: (owner, read, since) =>
      prototypeUnchanged?.(owner, read, since) === true,
    ownDescriptorIntact: (owner, key, read) =>
      ownDescriptorIntact?.(owner, key, read) === true,
    freshObject: interop.isFreshObject,
    ownSlotUnchanged: (owner, key, read, since, acceptedWrites) =>
      ownSlotUnchanged?.(owner, key, read, since, acceptedWrites) === true,
    prototypeTarget: (node) => {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return undefined;
      const invocation = interop.intrinsicInvocation(node);
      if (
        invocation?.kind !== "known" ||
        invocation.path.length !== 3 ||
        !["Object", "Reflect"].includes(invocation.path[1] ?? "") ||
        invocation.path[2] !== "getPrototypeOf"
      )
        return undefined;
      const target = invocation.arguments?.[0];
      return t.isNode(target) && !t.isSpreadElement(target)
        ? target
        : undefined;
    },
  };
  let ambientWrites = createAmbientPathResolver(state, true, referenceFacts);
  let observeOpaqueInvocation = createOpaqueObserver?.(ambientWrites);
  // Global own-data replacement proofs also need preceding opaque calls,
  // even when this source has no eval observer.
  const opaqueCalls = new Set<t.Node>();
  const accessorMutations = createPossibleAccessorMutations(
    state,
    ambientWrites,
    interop,
  );
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (root, kind, writeSite) => {
      if (kind === "opaque-call") return [];
      // Reassigning a local alias changes the binding, not the referenced object.
      if (kind === "binding") {
        if (
          !t.isIdentifier(root) ||
          !isUnshadowedGlobal(root, state, root.name)
        )
          return [];
        if (
          t.isAssignmentExpression(writeSite, { operator: "=" }) &&
          writeSite.left === root
        ) {
          const sources = globalRootSources.get(root.name) ?? [];
          sources.push({
            kind: "reference-store",
            node: writeSite.right,
            projection: [],
            mutation: writeSite,
          });
          globalRootSources.set(root.name, sources);
        }
        return [["global", root.name]];
      }
      if (!storedSites.has(writeSite)) {
        storedSites.add(writeSite);
        for (const source of semanticIterationSources(
          writeSite,
          state.parentsByNode.get(writeSite) ?? null,
        )) {
          // Fresh direct receivers identify one concrete slot. Keep replacement
          // evidence apart from reference edges, including primitive tombstones.
          if (
            source.kind === "reference-store" &&
            source.target !== undefined &&
            t.isAssignmentExpression(source.mutation, { operator: "=" }) &&
            source.mutation.left === source.target &&
            semanticStaticPropertyKey(
              source.target.property,
              source.target.computed,
            ) !== null
          )
            replacementSources.push(source);
          // Direct primitive values cannot retain an ambient object identity.
          // A projection may select a reference from a boxed primitive. Keeping
          // direct primitives in the alias graph makes every receiver escape
          // revisit every primitive field written by its methods.
          // Constructor allocation is the exception: a primitive .prototype
          // selects the realm's Object.prototype rather than that primitive.
          if (
            source.kind === "reference-store" &&
            (source.projection.length !== 0 ||
              !readExactJavaScriptLiteral(source.node).found ||
              (source.target !== undefined &&
                semanticStaticPropertyKey(
                  source.target.property,
                  source.target.computed,
                ) === "prototype"))
          )
            storedReferences.push(source);
        }
      }
      // Resolve identities after the traversal has collected every local store.
      const id = targets.push({ node: root, capture: writeSite }) - 1;
      return [["pending-target", String(id)]];
    },
    accessorMutations.invocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path, recipient, valueOnly) => {
      if (recipient !== undefined) {
        const recipients =
          intrinsicStoreRecipients.get(recipient.invocation) ??
          new Set<t.Node | undefined>();
        if (!recipients.has(recipient.target)) {
          recipients.add(recipient.target);
          intrinsicStoreRecipients.set(recipient.invocation, recipients);
          const sources = semanticIntrinsicDataStores(
            recipient,
            node,
            interop.staticString,
          );
          for (const source of sources) {
            if (source.propertyWrite === "define")
              storeKinds.set(source, "own-slot");
            if (
              semanticIntrinsicMutation(recipient.invocation)?.kind ===
                "define-property" &&
              source.propertyCopy === undefined &&
              source.invocationResult !== true
            ) {
              storeKinds.set(source, "own-data");
              replacementSources.push(source);
            }
            storedReferences.push(source);
          }
          const mutation = semanticIntrinsicMutation(recipient.invocation);
          const value = recipient.invocation.arguments?.[1];
          if (
            mutation?.kind === "set-prototype" &&
            t.isExpression(recipient.target) &&
            t.isNode(value) &&
            !t.isSpreadElement(value)
          ) {
            const source: SemanticIterationSource = {
              kind: "reference-store",
              node: value,
              projection: [],
              mutation: node,
              target: t.memberExpression(
                recipient.target,
                t.stringLiteral("__proto__"),
                true,
              ),
            };
            storeKinds.set(source, "prototype");
            storedReferences.push(source);
            replacementSources.push(source);
          }
        }
      }
      writes.push({
        node,
        path,
        ...(recipient === undefined ? {} : { recipient }),
        ...(valueOnly === undefined ? {} : { valueOnly }),
      });
    },
    (node, selectedInvocation) => {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        invocationSites.add(node);
      // A possible inherited helper supplies only mutation recipients. It
      // cannot suppress the receiver escape of an unresolved actual callable.
      const invocation = accessorMutations.candidates.has(node)
        ? undefined
        : selectedInvocation;
      opaqueCalls?.add(node);
      // Escaping objects can change contents without replacing their identity.
      const retainEscape = (
        target: t.Node,
        browserReceiver = false,
        argument = false,
      ) => {
        escapes.push({
          target,
          node,
          browserReceiver,
          ...(argument ? { argument: true } : {}),
        });
      };
      for (const argument of t.isTaggedTemplateExpression(node)
        ? node.quasi.expressions
        : node.arguments)
        if (t.isNode(argument))
          retainEscape(
            t.isSpreadElement(argument) ? argument.argument : argument,
            false,
            true,
          );
      const callee = unwrapJavaScriptExpression(
        t.isTaggedTemplateExpression(node) ? node.tag : node.callee,
      ).node;
      const browserMethod =
        invocation?.kind === "known" &&
        invocation.path.length === 2 &&
        ["open", "fetch"].includes(invocation.path[1] ?? "")
          ? invocation.path[1]
          : undefined;
      if (
        !t.isNewExpression(node) &&
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        !(
          invocation?.kind === "known" &&
          ["Object", "Reflect"].includes(invocation.path[1] ?? "")
        )
      ) {
        if (browserMethod !== undefined)
          browserReceiverMethods.add(browserMethod);
        retainEscape(callee.object, browserMethod !== undefined);
      }
    },
  );
  // Build all possible references before accepting strong replacements. A
  // superseded alias can still carry an earlier escape that freezes its owner.
  const pendingStores = new Set(storedReferences);
  const dependents = new WeakMap<
    SemanticStorageIdentity,
    Set<SemanticIterationSource>
  >();
  while (pendingStores.size > 0) {
    const source = pendingStores.values().next().value;
    if (source === undefined) break;
    pendingStores.delete(source);
    if (source.target === undefined) continue;
    const identities = new Map<SemanticStorageIdentity, AmbientProjection>();
    const key = semanticStaticPropertyKey(
      source.target.property,
      source.target.computed,
    );
    const observeStorageRead = (node: SemanticStorageIdentity) => {
      const users = dependents.get(node) ?? new Set<SemanticIterationSource>();
      users.add(source);
      dependents.set(node, users);
    };
    const retainIdentity = (
      node: SemanticStorageIdentity,
      receiver: AmbientProjection,
    ) => {
      // Resolve the receiver before appending the written key. An inherited
      // value is a possible read alias, never the owner of a new own slot.
      const path = receiver === undefined ? undefined : [...receiver, key];
      observeStorageRead(node);
      // Shared nominal prefixes schedule retries when their stored value is
      // discovered. Only the selected shared object owns this receiver's slot;
      // ancestor storage projections can also denote that very same object.
      if (isSemanticSharedStorageIdentity(node) && receiver?.length !== 0)
        return;
      identities.set(
        node,
        identities.has(node)
          ? joinAmbientProjection(identities.get(node), path)
          : path,
      );
    };
    ambientWrites(
      source.target.object,
      source.mutation,
      false,
      [],
      retainIdentity,
      retainIdentity,
      observeStorageRead,
    );
    // Publish only completed queries; each source/root projection can only widen.
    for (const [node, path] of identities) {
      const entries =
        stores.get(node) ??
        new Map<SemanticIterationSource, AmbientProjection>();
      const previous = entries.get(source);
      const joined = entries.has(source)
        ? joinAmbientProjection(previous, path)
        : path;
      if (
        entries.has(source) &&
        (previous === undefined ||
          (joined !== undefined &&
            previous.every((key, index) => key === joined[index])))
      )
        continue;
      entries.set(source, joined);
      stores.set(node, entries);
      for (const dependent of dependents.get(node) ?? [])
        pendingStores.add(dependent);
    }
    yield;
  }
  // Possible eval sites are proof inputs before pruning, not published facts.
  // The observer reuses its invocation owner and resolves final sites below.
  const weakGlobalSites = [...state.opaqueEffects.globalSites];
  const observeWeakOpaqueInvocation = createOpaqueObserver?.(
    ambientWrites,
    (node) => {
      weakGlobalSites.push(node);
    },
  );
  for (const node of opaqueCalls ?? []) observeWeakOpaqueInvocation?.(node);
  type DataSlot = "own" | "missing" | "unknown";
  const ordinaryContainers = new WeakMap<t.Node, boolean>();
  const dataSlots = new WeakMap<t.Node, Map<string, DataSlot>>();
  const dataSlot = (root: SemanticLocalIdentity, key: string): DataSlot => {
    if (isSemanticAllocatedReceiverIdentity(root) || key === "__proto__")
      return "unknown";
    let ordinary = ordinaryContainers.get(root);
    if (ordinary === undefined) {
      ordinary = t.isArrayExpression(root)
        ? !root.elements.some(t.isSpreadElement)
        : t.isObjectExpression(root) &&
          semanticLiteralObjectReferenceSources(root).prototype === undefined;
      ordinaryContainers.set(root, ordinary);
    }
    if (!ordinary) return "unknown";
    if (t.isArrayExpression(root))
      return key === "length" ? "unknown" : "missing";
    const slots = dataSlots.get(root) ?? new Map<string, DataSlot>();
    let slot = slots.get(key);
    if (slot === undefined) {
      const property = staticObjectProperty(root, key);
      slot =
        property.status === "explicit"
          ? "own"
          : property.status === "missing"
            ? "missing"
            : "unknown";
      slots.set(key, slot);
      dataSlots.set(root, slots);
    }
    return slot;
  };
  const resolveWeakTargets = () =>
    targets.map(({ node, capture }) => {
      const local = new Map<SemanticLocalIdentity, AmbientProjection>();
      const paths = ambientWrites(node, capture, false, [], (root, path) => {
        local.set(
          root,
          local.has(root) ? joinAmbientProjection(local.get(root), path) : path,
        );
      });
      return { paths, local };
    });
  let weakTargets: ReturnType<typeof resolveWeakTargets> | undefined;
  const completedTargets = () => (weakTargets ??= resolveWeakTargets());
  let weakBindingFacts: SemanticGlobalBindingFacts | undefined;
  const conversionEscapeEffects: SemanticGlobalBindingFacts["ambientWriteEffects"] =
    [];
  const completedBindingFacts = (): SemanticGlobalBindingFacts => {
    if (weakBindingFacts !== undefined) return weakBindingFacts;
    const facts: SemanticGlobalBindingFacts = {
      ambientWrites: new SemanticPropertyPathCoverage(),
      ambientWriteEffects: [],
      opaqueGlobalSites: weakGlobalSites,
      complete:
        observeWeakOpaqueInvocation !== undefined ||
        !state.opaqueEffects.mayReferenceGlobalEval,
    };
    const resolved = completedTargets();
    for (const { node, path, valueOnly } of writes) {
      const target =
        path[0] === "pending-target" ? resolved[Number(path[1])] : undefined;
      const paths =
        target === undefined
          ? [path]
          : target.paths.map((identity) =>
              canonicalAmbientPath([...identity, ...path.slice(2)]),
            );
      for (const identity of paths) {
        facts.ambientWrites.retain(identity);
        facts.ambientWriteEffects.push({
          path: identity,
          node,
          ...(valueOnly === undefined ? {} : { valueOnly }),
        });
      }
    }
    for (const escape of escapes)
      for (const identity of ambientWrites(
        escape.target,
        escape.node,
        true,
        escape.projection,
      )) {
        const path = canonicalAmbientPath([...identity, null]);
        if (identity[0] === "callable-value") {
          facts.ambientWrites.retain(path);
          facts.ambientWriteEffects.push({ path, node: escape.node });
        } else conversionEscapeEffects.push({ path, node: escape.node });
      }
    weakBindingFacts = facts;
    return facts;
  };
  // Complete the weak snapshot before any refined resolver can consult it.
  // Constructor receiver queries cannot justify their own binding stability.
  const bindingFacts = completedBindingFacts();
  const frozenInterop = (facts: SemanticGlobalBindingFacts) =>
    createSemanticModuleInterop(state, {
      intrinsicPath: interop.intrinsicPath,
      intrinsicWriteFacts: facts,
      bindingReadMayHaveChanged: (binding, read) =>
        semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
        (semanticBindingCanBeRebound(binding) &&
          semanticGlobalBindingReadMayHaveChanged(binding, read, state, facts)),
    });
  const proofInterop = frozenInterop(bindingFacts);
  // Conversion purity must retain every weak escape, including its own input.
  // Removing an escape cannot establish the native dependencies that justify it.
  const conversionFacts: SemanticGlobalBindingFacts = {
    ...bindingFacts,
    ambientWrites: new SemanticPropertyPathCoverage(),
    ambientWriteEffects: [
      ...bindingFacts.ambientWriteEffects,
      ...conversionEscapeEffects,
    ],
  };
  for (const effect of conversionFacts.ambientWriteEffects)
    conversionFacts.ambientWrites.retain(effect.path);
  const conversionInterop = frozenInterop(conversionFacts);
  for (const [source, path] of stores.get(sharedStorage(["global"])) ?? [])
    if (
      path?.length === 1 &&
      typeof path[0] === "string" &&
      t.isAssignmentExpression(source.mutation, { operator: "=" }) &&
      source.target === source.mutation.left
    ) {
      const entries = globalRootSources.get(path[0]) ?? [];
      entries.push(source);
      globalRootSources.set(path[0], entries);
    }
  globalRootReplacement = createSemanticGlobalRootReplacementQuery(
    state,
    bindingFacts,
    globalRootSources,
    {
      freshObject: proofInterop.isFreshObject,
      // A nominal callable path does not prove absence of descriptor effects.
      opaqueSites: [...(opaqueCalls ?? [])],
    },
  );
  // Provisional result/receiver caches retain all possible inherited objects.
  // Refinement owns fresh caches and consumes the frozen weak proof inputs.
  ambientWrites = createAmbientPathResolver(state, true, {
    ...referenceFacts,
    freshObject: proofInterop.isFreshObject,
    definiteObject: proofInterop.isDefinitelyObject,
    intrinsicWriteFacts: bindingFacts,
  });
  // Early recipient candidates remain in weak proof inputs. Refine the parsed
  // invocation once before publishing or interpreting its possible writes.
  const selectedRecipients = new WeakMap<
    JavaScriptIntrinsicMutationRecipient["invocation"],
    ReadonlySet<t.Node | undefined>
  >();
  const activeWrites = writes.filter(({ recipient }) => {
    if (recipient === undefined) return true;
    let selected = selectedRecipients.get(recipient.invocation);
    if (selected === undefined) {
      selected = new Set(
        semanticIntrinsicMutationTargets(
          recipient.invocation,
          proofInterop.isFreshObject,
        ),
      );
      selectedRecipients.set(recipient.invocation, selected);
    }
    return selected.has(recipient.target);
  });
  const descriptorWrites: JavaScriptSemanticMemberEffect[] = [];
  for (const { node, path } of activeWrites) {
    const target =
      path[0] === "pending-target"
        ? completedTargets()[Number(path[1])]
        : undefined;
    for (const identity of target === undefined
      ? [path]
      : target.paths.map((identity) =>
          canonicalAmbientPath([...identity, ...path.slice(2)]),
        )) {
      // A deletion cannot replace the initial inherited data descriptor while
      // the wrapper's own slot remains absent. Every other preceding write and
      // escape is still checked below, independently of these candidates.
      if (
        semanticModuleDelegateWriteOwner(identity, node, proofInterop)
          ?.deletesInitiallyAbsentOwnSlot
      )
        continue;
      descriptorWrites.push({ node, path: identity });
    }
  }
  const refineArgumentEscapes = (
    sources: typeof escapes,
    dataPropertyIntact?: (node: t.Node, target: t.Node, key: string) => boolean,
    replace?: (node: t.Node, selected: readonly t.Node[]) => void,
  ): typeof escapes => {
    const argumentsByCall = new Map<t.Node, typeof escapes>();
    const refined = sources.filter((escape) => {
      if (
        !escape.argument ||
        (!t.isCallExpression(escape.node) &&
          !t.isOptionalCallExpression(escape.node))
      )
        return true;
      const arguments_ = argumentsByCall.get(escape.node) ?? [];
      arguments_.push(escape);
      argumentsByCall.set(escape.node, arguments_);
      return false;
    });
    for (const node of invocationSites) {
      const selected = proofInterop.callArgumentEscapes(
        node,
        dataPropertyIntact === undefined
          ? undefined
          : (target, key) => dataPropertyIntact(node, target, key),
      );
      if (selected === undefined) {
        refined.push(...(argumentsByCall.get(node) ?? []));
      } else {
        replace?.(node, selected);
        for (const target of selected)
          refined.push({
            node,
            target,
            browserReceiver: false,
            argument: true,
          });
      }
    }
    return refined;
  };
  // Retain the complete weak inputs above for intrinsic proof. These first
  // refinements need no descriptor assumptions: allocation/binding stores a
  // reference, and reflective deletion is already represented by its write.
  const retainedEscapes = refineArgumentEscapes(escapes);
  const escapeFacts = new Set<JavaScriptSemanticMemberEffect>();
  const descriptorDependencies = new Map<
    string,
    {
      readonly path: readonly string[];
      readonly effects: ReturnType<
        typeof createSemanticPrecedingEffectIndex<JavaScriptSemanticMemberEffect>
      >;
    }
  >();
  const descriptorDependencyIntact = (
    path: readonly string[],
    node: t.Node,
  ): boolean => {
    const key = JSON.stringify(path);
    let dependency = descriptorDependencies.get(key);
    if (dependency === undefined) {
      const effects =
        createSemanticPrecedingEffectIndex<JavaScriptSemanticMemberEffect>(
          state.parentsByNode,
          (capture, effect) =>
            semanticEffectTiming(capture, effect, state) === "after",
        );
      for (const effect of [...descriptorWrites, ...escapeFacts])
        if (semanticPropertyPathMayAffect(effect.path, path))
          effects.add(effect);
      dependency = { path, effects };
      descriptorDependencies.set(key, dependency);
    }
    return !dependency.effects.mayPrecede(node);
  };
  const originalEscapes = new WeakMap<
    t.Node,
    JavaScriptSemanticMemberEffect[]
  >();
  const retainEscapeFacts = (
    escape: (typeof escapes)[number],
    original: boolean,
  ): void => {
    for (const path of ambientWrites(
      escape.target,
      escape.node,
      true,
      escape.projection,
    )) {
      const escaped = canonicalAmbientPath([...path, null]);
      const effect = { node: escape.node, path: escaped };
      escapeFacts.add(effect);
      for (const dependency of descriptorDependencies.values())
        if (semanticPropertyPathMayAffect(escaped, dependency.path))
          dependency.effects.add(effect);
      if (original && escape.argument) {
        const effects = originalEscapes.get(escape.node) ?? [];
        effects.push(effect);
        originalEscapes.set(escape.node, effects);
      }
    }
  };
  for (const escape of retainedEscapes) retainEscapeFacts(escape, true);
  const opaqueModuleEffects = [...state.opaqueEffects.byScope.values()].flat();
  const dataPropertyIntact = (
    node: t.Node,
    target: t.Node,
    key: string,
  ): boolean => {
    const prior = (effect: t.Node | undefined) =>
      semanticEffectTiming(node, effect, state) !== "after";
    if (
      !isUnshadowedGlobal(
        unwrapJavaScriptExpression(target).node,
        state,
        "module",
      ) ||
      bindingFacts.complete !== true ||
      opaqueModuleEffects.some(prior) ||
      weakGlobalSites.some(prior) ||
      (state.ambientBindingWrites.get("module") ?? []).some(prior)
    )
      return false;
    const paths = ambientReads(target);
    return (
      paths.length > 0 &&
      paths.every((path) => {
        if (!path.every((segment): segment is string => segment !== null))
          return false;
        const dependencies = semanticInitialModuleDelegateDataProperty([
          ...path,
          key,
        ]);
        return (
          dependencies !== undefined &&
          dependencies.every(({ path }) =>
            descriptorDependencyIntact(path, node),
          )
        );
      })
    );
  };
  const activeEscapes = refineArgumentEscapes(
    retainedEscapes,
    dataPropertyIntact,
    (node, selected) => {
      // Retire only the proven call's argument effects, preserving receiver
      // records at the same node. Later calls consume the updated timing index.
      for (const effect of originalEscapes.get(node) ?? []) {
        escapeFacts.delete(effect);
        for (const dependency of descriptorDependencies.values())
          dependency.effects.delete(effect);
      }
      for (const target of selected)
        retainEscapeFacts({ node, target, browserReceiver: false }, false);
    },
  );
  observeOpaqueInvocation = createOpaqueObserver?.(ambientWrites);
  const activeTargetIds = new Set(
    activeWrites.flatMap(({ path }) =>
      path[0] === "pending-target" ? [Number(path[1])] : [],
    ),
  );
  let memberWrites:
    | WeakMap<SemanticLocalIdentity, Map<string | null, Set<t.Node>>>
    | undefined;
  const writesToMember = (
    root: SemanticLocalIdentity,
    key: string,
  ): readonly t.Node[] => {
    if (memberWrites === undefined) {
      memberWrites = new WeakMap();
      const resolved = completedTargets();
      for (const { node, path } of activeWrites) {
        if (path[0] !== "pending-target") continue;
        for (const [owner, projection] of resolved[Number(path[1])]?.local ??
          []) {
          const member =
            projection === undefined
              ? undefined
              : [...projection, ...path.slice(2)];
          if (
            member !== undefined &&
            member.length > 1 &&
            !(
              !isSemanticAllocatedReceiverIdentity(owner) &&
              (t.isFunction(owner) || t.isClass(owner)) &&
              member[0] === "prototype"
            )
          )
            continue;
          const byKey =
            memberWrites.get(owner) ?? new Map<string | null, Set<t.Node>>();
          const memberKey = member?.[0] ?? null;
          const sites = byKey.get(memberKey) ?? new Set<t.Node>();
          sites.add(node);
          byKey.set(memberKey, sites);
          memberWrites.set(owner, byKey);
        }
      }
    }
    const byKey = memberWrites.get(root);
    return [...(byKey?.get(key) ?? []), ...(byKey?.get(null) ?? [])];
  };
  interface ReceiverSlot {
    readonly root: SemanticLocalIdentity;
    readonly key: string;
    readonly slot: "own" | "missing";
  }
  interface StoreReceiver extends ReceiverSlot {
    readonly guards: readonly ReceiverSlot[];
  }
  const freshRoot = (
    node: t.Node,
    capture: t.Node,
  ): SemanticLocalIdentity | null => {
    if (!proofInterop.isFreshObject(node)) return null;
    const identities = new Map<SemanticLocalIdentity, AmbientProjection>();
    const ambient = ambientWrites(node, capture, false, [], (root, path) => {
      identities.set(
        root,
        identities.has(root)
          ? joinAmbientProjection(identities.get(root), path)
          : path,
      );
    });
    if (ambient.length !== 0 || identities.size !== 1) return null;
    for (const [root, path] of identities) if (path?.length === 0) return root;
    return null;
  };
  const receiverFacts = new WeakMap<
    SemanticIterationSource,
    StoreReceiver | null
  >();
  const storeReceiver = (
    source: SemanticIterationSource,
  ): StoreReceiver | null => {
    const cached = receiverFacts.get(source);
    if (cached !== undefined) return cached;
    // Recursive store dependencies cannot establish their own completeness.
    receiverFacts.set(source, null);
    // Finding one local alternative does not establish complete receiver
    // identity. Returned, mixed, accessor, and prototype receivers may consume
    // the RHS even when their other alternatives are fresh local containers.
    const target = source.target;
    if (target === undefined) return null;
    const key = semanticStaticPropertyKey(target.property, target.computed);
    if (key === null) return null;
    const path = electronMemberPath(target.object);
    let root = freshRoot(path.root, source.mutation);
    if (root === null) return null;
    const guards: ReceiverSlot[] = [];
    // Member receivers need complete contents, not merely one recovered local
    // alternative. Follow only exact fresh stores in the completed weak graph.
    for (const member of path.members) {
      if (member === null) return null;
      const slot = dataSlot(root, member);
      if (slot === "unknown") return null;
      guards.push({ root, key: member, slot });
      let selected: SemanticLocalIdentity | null = null;
      let definite = false;
      const accepted = new Set<t.Node>();
      for (const [stored, projection] of stores.get(root) ?? []) {
        if (
          semanticEffectTiming(source.mutation, stored.mutation, state) ===
            "after" ||
          semanticReferenceSourcesInactive(stored, state, "syntax-only")
        )
          continue;
        if (projection === undefined) return null;
        if (projection.length !== 1) continue;
        if (projection[0] === null) return null;
        if (projection[0] !== member) continue;
        if (stored.projection.length !== 0) return null;
        const receiver = storeReceiver(stored);
        const value = freshRoot(stored.node, stored.node);
        if (
          receiver?.root !== root ||
          receiver.key !== member ||
          value === null ||
          (selected !== null && selected !== value)
        )
          return null;
        selected = value;
        guards.push(...receiver.guards);
        accepted.add(stored.mutation);
        definite ||= semanticDefiniteMutationPrecedesRead(
          stored.mutation,
          source.mutation,
          state.parentsByNode,
        );
      }
      // Primitive and unknown writes are intentionally absent from reference
      // edges. The existing write index still excludes them from a fresh proof.
      if (
        writesToMember(root, member).some(
          (site) =>
            semanticEffectTiming(source.mutation, site, state) !== "after" &&
            !accepted.has(site),
        )
      )
        return null;
      const initial = isSemanticAllocatedReceiverIdentity(root)
        ? { status: "dynamic" as const }
        : staticObjectProperty(root, member);
      if (initial.status === "explicit") {
        const value = freshRoot(initial.property.value, initial.property.value);
        if (value === null || (selected !== null && selected !== value))
          return null;
        selected = value;
        definite = true;
      }
      if (selected === null || !definite) return null;
      root = selected;
    }
    if (
      source.propertyLookup !== undefined &&
      source.propertyLookup.target !== target.object
    ) {
      const lookup = source.propertyLookup.target;
      const lookupRoot =
        lookup === undefined ? null : freshRoot(lookup, source.mutation);
      if (lookupRoot === null) return null;
      const lookupSlot = dataSlot(lookupRoot, key);
      if (lookupSlot === "unknown") return null;
      // Receiver data alone cannot exclude a target setter consuming the RHS.
      // Its lookup owner needs the same completed descriptor/prototype guards.
      guards.push({ root: lookupRoot, key, slot: lookupSlot });
    }
    const slot = dataSlot(root, key);
    if (slot === "unknown") return null;
    guards.push({ root, key, slot });
    const receiver: StoreReceiver = { root, key, slot, guards };
    receiverFacts.set(source, receiver);
    return receiver;
  };
  const trustedMutation = (site: t.Node) => {
    if (!t.isCallExpression(site) && !t.isOptionalCallExpression(site))
      return undefined;
    const invocation = proofInterop.intrinsicInvocation(site);
    if (invocation?.kind !== "known") return undefined;
    const mutation = semanticIntrinsicMutation(invocation);
    return mutation === undefined ? undefined : { mutation, invocation };
  };
  const integrityMutation = (site: t.Node): boolean => {
    if (!t.isCallExpression(site) && !t.isOptionalCallExpression(site))
      return false;
    const invocation = proofInterop.intrinsicInvocation(site);
    return (
      invocation?.kind === "known" &&
      [
        "intrinsic.Object.freeze",
        "intrinsic.Object.seal",
        "intrinsic.Object.preventExtensions",
      ].includes(invocation.path.join("."))
    );
  };
  const inertDescriptorMutation = (site: t.Node) => {
    const parsed = trustedMutation(site);
    if (
      parsed?.mutation.kind !== "define-property" ||
      parsed.mutation.receiver === true
    )
      return undefined;
    const input = parsed.invocation.arguments?.[2];
    const descriptor = t.isObjectExpression(input)
      ? input
      : t.isNode(input) && !t.isSpreadElement(input)
        ? ambientWrites.descriptorInputObject(input, site)
        : undefined;
    if (
      !t.isObjectExpression(descriptor) ||
      semanticObjectPrototypeProperty(descriptor) !== undefined ||
      descriptor.properties.some(
        (property) =>
          t.isSpreadElement(property) ||
          (t.isObjectMethod(property) && property.kind !== "method") ||
          semanticStaticPropertyKey(property.key, property.computed) === null,
      )
    )
      return undefined;
    const key = proofInterop.staticString(parsed.mutation.key);
    return key === undefined ? undefined : { key, descriptor };
  };
  const receiverUsers = new WeakMap<
    SemanticLocalIdentity,
    Set<SemanticIterationSource>
  >();
  const inheritedReceiverUsers = new Set<SemanticIterationSource>();
  const pendingReferenceEscapes = new Set(storedReferences);
  const escapedReferences = new WeakSet<SemanticIterationSource>();
  const definiteDescriptorEffects = new WeakMap<
    SemanticLocalIdentity,
    Set<t.Node>
  >();
  const speculativeDescriptorEffects = new WeakMap<
    SemanticLocalIdentity,
    Map<t.Node, Set<SemanticIterationSource>>
  >();
  for (const source of storedReferences) {
    const receiver = storeReceiver(source);
    if (receiver === null) continue;
    for (const guard of receiver.guards) {
      const users =
        receiverUsers.get(guard.root) ?? new Set<SemanticIterationSource>();
      users.add(source);
      receiverUsers.set(guard.root, users);
      if (guard.slot === "missing") inheritedReceiverUsers.add(source);
    }
  }
  const descriptorEffects = new WeakMap<SemanticLocalIdentity, Set<t.Node>>();
  const prototypeEffects = new Set<t.Node>();
  const definitePrototypeEffects = new Set<t.Node>();
  const speculativePrototypeEffects = new Map<
    t.Node,
    Set<SemanticIterationSource>
  >();
  const activePrototypeEffects = () =>
    new Set(
      [...prototypeEffects].filter(
        (site) =>
          definitePrototypeEffects.has(site) ||
          [...(speculativePrototypeEffects.get(site) ?? [])].some(
            (source) => !inertReferenceStores.has(source),
          ),
      ),
    );
  const retainDescriptorEffect = (
    root: SemanticLocalIdentity,
    site: t.Node,
    source?: SemanticIterationSource,
  ): void => {
    if (source === undefined) {
      const sites = definiteDescriptorEffects.get(root) ?? new Set<t.Node>();
      sites.add(site);
      definiteDescriptorEffects.set(root, sites);
    } else {
      const bySite =
        speculativeDescriptorEffects.get(root) ??
        new Map<t.Node, Set<SemanticIterationSource>>();
      const sources = bySite.get(site) ?? new Set<SemanticIterationSource>();
      sources.add(source);
      bySite.set(site, sources);
      speculativeDescriptorEffects.set(root, bySite);
    }
    const effects = descriptorEffects.get(root) ?? new Set<t.Node>();
    if (effects.has(site)) return;
    effects.add(site);
    descriptorEffects.set(root, effects);
    for (const source of receiverUsers.get(root) ?? [])
      if (!escapedReferences.has(source)) pendingReferenceEscapes.add(source);
  };
  const activeDescriptorEffects = (root: SemanticLocalIdentity) =>
    new Set(
      [...(descriptorEffects.get(root) ?? [])].filter(
        (site) =>
          definiteDescriptorEffects.get(root)?.has(site) === true ||
          [...(speculativeDescriptorEffects.get(root)?.get(site) ?? [])].some(
            (source) => !inertReferenceStores.has(source),
          ),
      ),
    );
  const retainPrototypeEffect = (
    site: t.Node,
    source?: SemanticIterationSource,
  ): void => {
    // A trusted plain data descriptor that explicitly remains writable cannot
    // introduce an inherited setter or prevent creation of a receiver's slot.
    const descriptor = inertDescriptorMutation(site)?.descriptor;
    if (
      descriptor !== undefined &&
      staticObjectOwnProperty(descriptor, "get").status === "missing" &&
      staticObjectOwnProperty(descriptor, "set").status === "missing"
    ) {
      const writable = staticObjectProperty(descriptor, "writable");
      if (writable.status === "explicit") {
        const literal = readExactJavaScriptLiteral(writable.property.value);
        if (literal.found && literal.value === true) return;
      }
    }
    if (source === undefined) definitePrototypeEffects.add(site);
    else {
      const sources =
        speculativePrototypeEffects.get(site) ??
        new Set<SemanticIterationSource>();
      sources.add(source);
      speculativePrototypeEffects.set(site, sources);
    }
    if (prototypeEffects.has(site)) return;
    prototypeEffects.add(site);
    for (const source of inheritedReceiverUsers)
      if (!escapedReferences.has(source)) pendingReferenceEscapes.add(source);
  };
  const mayReachPrototype = semanticBuiltinDataPrototypeMayBeReached;
  // Resolve each discovered escape once against the completed weak graph.
  // Its descriptor effects recheck only stores depending on that receiver.
  const resolvedEscapes: {
    node: t.Node;
    browserReceiver: boolean;
    paths: readonly AmbientPath[];
    source?: SemanticIterationSource;
  }[] = [];
  const resolveEscape = (
    escape: (typeof escapes)[number],
    source?: SemanticIterationSource,
  ): void => {
    if (
      source === undefined &&
      conversionInterop.nonEscapingConversionInput(escape.node) ===
        escape.target
    )
      return;
    const descriptor = inertDescriptorMutation(escape.node);
    const invocation =
      descriptor === undefined
        ? undefined
        : trustedMutation(escape.node)?.invocation;
    const target = invocation?.arguments?.[0];
    if (t.isNode(target) && !t.isSpreadElement(target)) {
      const receiver = freshRoot(target, escape.node);
      const builtin =
        receiver === null
          ? proofInterop.capturedIntrinsicPath(target)
          : undefined;
      if (
        receiver !== null ||
        (builtin !== undefined &&
          ["Object", "Function", "Reflect"].includes(builtin[1] ?? "") &&
          (builtin.length === 2 ||
            semanticBuiltinDataPrototypeOwner(builtin) !== undefined))
      ) {
        if (receiver !== null) retainDescriptorEffect(receiver, escape.node);
        return;
      }
    }
    const paths = ambientWrites(
      escape.target,
      escape.node,
      true,
      escape.projection,
      (root, path) => {
        if (
          path === undefined ||
          path.length === 0 ||
          (!isSemanticAllocatedReceiverIdentity(root) &&
            (t.isFunction(root) || t.isClass(root)) &&
            path[0] === "prototype")
        )
          retainDescriptorEffect(root, escape.node, source);
        if (path?.includes("__proto__"))
          retainPrototypeEffect(escape.node, source);
      },
    );
    if (paths.some(mayReachPrototype))
      retainPrototypeEffect(escape.node, source);
    resolvedEscapes.push({
      node: escape.node,
      browserReceiver: escape.browserReceiver,
      paths,
      ...(source === undefined ? {} : { source }),
    });
  };
  for (const escape of activeEscapes) resolveEscape(escape);
  {
    // Existing write targets also own delete/prototype evidence. Resolve each
    // target once here, rather than scanning all writes for every stored slot.
    const weakTargets = completedTargets();
    for (const [index, target] of weakTargets.entries()) {
      if (!activeTargetIds.has(index)) continue;
      for (const path of target.local.values())
        if (path === undefined || path.includes("__proto__"))
          retainPrototypeEffect(targets[index]!.capture);
    }
    for (const { node, path } of activeWrites) {
      const target =
        path[0] === "pending-target" ? weakTargets[Number(path[1])] : undefined;
      const paths =
        target === undefined
          ? [path]
          : target.paths.map((identity) =>
              canonicalAmbientPath([...identity, ...path.slice(2)]),
            );
      if (paths.some(mayReachPrototype)) retainPrototypeEffect(node);
      if (
        t.isUnaryExpression(node, { operator: "delete" }) ||
        path.slice(2).some((key) => key === null || key === "__proto__")
      )
        for (const [root, projection] of target?.local ?? [])
          if (projection === undefined || projection.length === 0)
            retainDescriptorEffect(root, node);
    }
  }
  const effectMayPrecede = (
    mutation: t.Node,
    effects: Iterable<t.Node> | undefined,
  ): boolean => {
    for (const site of effects ?? [])
      if (semanticEffectTiming(mutation, site, state) !== "after") return true;
    return false;
  };
  const inertReceiver = (
    source: SemanticIterationSource,
  ): StoreReceiver | null => {
    const receiver = storeReceiver(source);
    return receiver !== null &&
      receiver.guards.every(
        (guard) =>
          !effectMayPrecede(
            source.mutation,
            activeDescriptorEffects(guard.root),
          ) &&
          (guard.slot === "own" ||
            !effectMayPrecede(source.mutation, activePrototypeEffects())),
      )
      ? receiver
      : null;
  };
  // An escaped RHS may invalidate another tentative receiver proof. Each store
  // escapes at most once; only affected receiver/prototype users are revisited.
  while (pendingReferenceEscapes.size > 0) {
    const source = pendingReferenceEscapes.values().next().value;
    if (source === undefined) break;
    pendingReferenceEscapes.delete(source);
    if (escapedReferences.has(source) || inertReceiver(source) !== null)
      continue;
    escapedReferences.add(source);
    resolveEscape(
      {
        node: source.mutation,
        target: source.node,
        browserReceiver: false,
        projection: source.projection.map((key) =>
          key === null || typeof key === "object" ? null : String(key),
        ),
      },
      source,
    );
    yield;
  }
  // Exclusion needs the completed write/escape snapshot. Earlier resolver
  // queries retain inherited possibilities; their declarative slot cache does
  // not memoize this mutable proof, and possible-write paths are never cached.
  const preservesOwnSlot = (
    owner: SemanticLocalIdentity,
    site: t.Node,
    key: string,
    presenceOnly: boolean,
  ) => {
    if (integrityMutation(site)) return true;
    if (
      !isSemanticAllocatedReceiverIdentity(owner) &&
      ambientWrites.prototypeSlotAssignmentPreservesOwnDescriptors(
        owner,
        site,
        ![...activePrototypeEffects()].some(
          (effect) =>
            effect !== site &&
            semanticEffectTiming(site, effect, state) !== "after",
        ),
      )
    )
      return true;
    if (trustedMutation(site)?.mutation.kind === "set-prototype") return true;
    const descriptor = inertDescriptorMutation(site);
    return (
      descriptor !== undefined &&
      (descriptor.key !== key ||
        (presenceOnly &&
          !isSemanticAllocatedReceiverIdentity(owner) &&
          staticObjectOwnProperty(owner, key).status === "explicit"))
    );
  };
  const descriptorEffectMayPrecede = (
    owner: SemanticLocalIdentity,
    key: string,
    read: t.Node,
    effects: ReadonlySet<t.Node> | undefined,
    presenceOnly: boolean,
    since?: t.Node,
  ) => {
    for (const site of effects ?? [])
      if (
        site !== read &&
        site !== since &&
        !(
          since !== undefined &&
          semanticDefiniteMutationPrecedesRead(site, since, state.parentsByNode)
        ) &&
        semanticEffectTiming(read, site, state) !== "after" &&
        !preservesOwnSlot(owner, site, key, presenceOnly)
      )
        return true;
    return false;
  };
  ownDescriptorIntact = (owner, key, read) =>
    !descriptorEffectMayPrecede(
      owner,
      key,
      read,
      activeDescriptorEffects(owner),
      true,
    ) &&
    !writesToMember(owner, key).some(
      (site) =>
        semanticEffectTiming(read, site, state) !== "after" &&
        !(t.isAssignmentExpression(site) && site.operator === "=") &&
        !preservesOwnSlot(owner, site, key, true),
    );
  ownSlotUnchanged = (owner, key, read, since, acceptedWrites) =>
    !descriptorEffectMayPrecede(
      owner,
      key,
      read,
      activeDescriptorEffects(owner),
      false,
      since,
    ) &&
    !writesToMember(owner, key).some(
      (site) =>
        site !== read &&
        site !== since &&
        !acceptedWrites?.has(site) &&
        !(
          since !== undefined &&
          semanticDefiniteMutationPrecedesRead(site, since, state.parentsByNode)
        ) &&
        semanticEffectTiming(read, site, state) !== "after" &&
        !(
          preservesOwnSlot(owner, site, key, false) &&
          (key !== "__proto__" ||
            (!isSemanticAllocatedReceiverIdentity(owner) &&
              staticObjectOwnProperty(owner, key).status === "explicit"))
        ),
    );
  // The captured prototype value can stay the same while its constructor slot
  // acquires an accessor. Allocated own stores also need its contents intact.
  constructorPrototypeUnchanged = (owner, read) =>
    !effectMayPrecede(read, activeDescriptorEffects(owner)) &&
    !effectMayPrecede(read, writesToMember(owner, "prototype"));
  prototypeUnchanged = (owner, read, since) => {
    const effects = new Set([
      ...(activeDescriptorEffects(owner) ?? []),
      ...writesToMember(owner, "__proto__"),
    ]);
    for (const site of effects) {
      if (
        site === read ||
        site === since ||
        semanticEffectTiming(read, site, state) === "after" ||
        (since !== undefined &&
          semanticDefiniteMutationPrecedesRead(
            site,
            since,
            state.parentsByNode,
          )) ||
        inertDescriptorMutation(site) !== undefined ||
        integrityMutation(site)
      )
        continue;
      if (
        t.isAssignmentExpression(site) &&
        site.operator === "=" &&
        staticObjectOwnProperty(owner, "__proto__").status === "explicit" &&
        ownDescriptorIntact?.(owner, "__proto__", site) === true
      )
        continue;
      return false;
    }
    return true;
  };
  const trustedDataSource = (source: SemanticIterationSource, key: string) => {
    const parsed = inertDescriptorMutation(source.mutation);
    const selected =
      parsed === undefined
        ? undefined
        : staticObjectProperty(parsed.descriptor, "value");
    return source.invocationResult !== true &&
      storeKinds.get(source) === "own-data" &&
      parsed?.key === key &&
      selected?.status === "explicit"
      ? { ...parsed, value: selected.property.value }
      : undefined;
  };
  const sameStoredValue = (left: t.Node | undefined, right: t.Node) => {
    if (left === right) return true;
    if (left === undefined) return false;
    const a = readExactJavaScriptLiteral(left);
    const b = readExactJavaScriptLiteral(right);
    return a.found && b.found && Object.is(a.value, b.value);
  };
  const writableOwnDataAt = (
    owner: t.Node,
    key: string,
    source: SemanticIterationSource,
  ): boolean => {
    const initial = staticObjectOwnProperty(owner, key);
    if (initial.status === "dynamic") return false;
    let exists = initial.status === "explicit";
    let accessor =
      initial.status === "explicit" &&
      t.isObjectMethod(initial.property) &&
      initial.property.kind !== "method";
    let writable = exists && !accessor;
    let configurable = exists;
    let enumerable = exists;
    let value: t.Node | undefined =
      initial.status === "explicit" && t.isObjectProperty(initial.property)
        ? initial.property.value
        : undefined;
    const descriptors: SemanticIterationSource[] = [];
    for (const [stored, path] of stores.get(owner) ?? [])
      if (
        path?.length === 1 &&
        path[0] === key &&
        trustedDataSource(stored, key) !== undefined &&
        (stored === source ||
          semanticDefiniteMutationPrecedesRead(
            stored.mutation,
            source.mutation,
            state.parentsByNode,
          ))
      )
        descriptors.push(stored);
    const recognized = new Set(descriptors.map((stored) => stored.mutation));
    const harmless = (site: t.Node) =>
      site === source.mutation ||
      semanticEffectTiming(source.mutation, site, state) === "after" ||
      (preservesOwnSlot(owner, site, key, false) && !integrityMutation(site)) ||
      recognized.has(site);
    // A member assignment can also escape this object into an unrelated
    // setter. Only the direct slot-write index can grant data-write semantics.
    for (const site of activeDescriptorEffects(owner) ?? [])
      if (!harmless(site)) return false;
    for (const site of writesToMember(owner, key)) {
      if (
        harmless(site) ||
        (t.isAssignmentExpression(site) && site.operator === "=")
      )
        continue;
      return false;
    }
    descriptors.sort(
      (left, right) => (left.mutation.start ?? 0) - (right.mutation.start ?? 0),
    );
    let previous: t.Node | undefined;
    for (const stored of descriptors) {
      if (
        previous !== undefined &&
        !semanticDefiniteMutationPrecedesRead(
          previous,
          stored.mutation,
          state.parentsByNode,
        )
      )
        return false;
      previous = stored.mutation;
      const descriptor = trustedDataSource(stored, key)!.descriptor;
      const attribute = (name: string): boolean | undefined | "unknown" => {
        const selected = staticObjectProperty(descriptor, name);
        if (selected.status === "missing") return undefined;
        if (selected.status !== "explicit") return "unknown";
        const literal = readExactJavaScriptLiteral(selected.property.value);
        return literal.found && typeof literal.value === "boolean"
          ? literal.value
          : "unknown";
      };
      const nextWritable = attribute("writable");
      const nextConfigurable = attribute("configurable");
      const nextEnumerable = attribute("enumerable");
      if (
        nextWritable === "unknown" ||
        nextConfigurable === "unknown" ||
        nextEnumerable === "unknown"
      )
        return false;
      if (
        exists &&
        !configurable &&
        (accessor ||
          nextConfigurable === true ||
          (nextEnumerable !== undefined && nextEnumerable !== enumerable) ||
          (!writable &&
            (nextWritable === true ||
              !sameStoredValue(value, trustedDataSource(stored, key)!.value))))
      )
        return false;
      writable = nextWritable ?? (exists && !accessor ? writable : false);
      configurable = nextConfigurable ?? (exists ? configurable : false);
      enumerable = nextEnumerable ?? (exists ? enumerable : false);
      exists = true;
      accessor = false;
      value = trustedDataSource(stored, key)!.value;
    }
    return storeKinds.get(source) === "own-data"
      ? recognized.has(source.mutation)
      : (exists && !accessor && writable) ||
          (!exists &&
            ambientWrites.dataWritePossible(
              owner,
              key,
              source.mutation,
              !effectMayPrecede(source.mutation, activePrototypeEffects()),
            ));
  };
  const strongSlotReceiver = (
    source: SemanticIterationSource,
  ): { root: SemanticLocalIdentity; key: AmbientReplacementKey } | null => {
    const ordinary = inertReceiver(source);
    if (
      ordinary !== null &&
      storeKinds.get(source) === undefined &&
      ordinary.key !== "__proto__"
    )
      return ordinary;
    if (source.target === undefined) return null;
    const key = semanticStaticPropertyKey(
      source.target.property,
      source.target.computed,
    );
    const root = freshRoot(source.target.object, source.mutation);
    if (key === null || root === null) return null;
    if (isSemanticAllocatedReceiverIdentity(root)) return null;
    const kind = storeKinds.get(source);
    if (kind === "own-data" && trustedDataSource(source, key) === undefined)
      return null;
    const physical =
      kind === "prototype" ||
      (kind === undefined &&
        key === "__proto__" &&
        ambientWrites.nativePrototypeAssignmentChangesLink(
          root,
          source.mutation,
          ![...activePrototypeEffects()].some(
            (effect) =>
              effect !== source.mutation &&
              semanticEffectTiming(source.mutation, effect, state) !== "after",
          ),
        ));
    if (physical) {
      if (
        kind === "prototype" &&
        trustedMutation(source.mutation)?.mutation.kind !== "set-prototype"
      )
        return null;
      const valueKind = ambientWrites.prototypeKind(source.node);
      if (valueKind !== "object" && valueKind !== "null") return null;
      for (const site of activeDescriptorEffects(root)) {
        if (
          site === source.mutation ||
          semanticEffectTiming(source.mutation, site, state) === "after" ||
          inertDescriptorMutation(site) !== undefined ||
          trustedMutation(site)?.mutation.kind === "set-prototype" ||
          ambientWrites.prototypeSlotAssignmentPreservesOwnDescriptors(
            root,
            site,
            ![...activePrototypeEffects()].some(
              (effect) =>
                effect !== site &&
                semanticEffectTiming(site, effect, state) !== "after",
            ),
          )
        )
          continue;
        return null;
      }
      return { root, key: SEMANTIC_PHYSICAL_PROTOTYPE };
    }
    return writableOwnDataAt(root, key, source)
      ? { root, key }
      : kind === undefined
        ? ordinary
        : null;
  };
  // One completed replacement index serves ordinary reads, source candidates,
  // and physical prototype lookup. Captured earlier values keep their edges.
  for (const source of replacementSources) {
    const receiver = strongSlotReceiver(source);
    if (receiver === null) continue;
    if (
      receiver.key !== SEMANTIC_PHYSICAL_PROTOTYPE ||
      storeKinds.get(source) === "prototype" ||
      (!isSemanticAllocatedReceiverIdentity(receiver.root) &&
        ambientWrites.prototypeSlotAssignmentPreservesOwnDescriptors(
          receiver.root,
          source.mutation,
          ![...activePrototypeEffects()].some(
            (effect) =>
              effect !== source.mutation &&
              semanticEffectTiming(source.mutation, effect, state) !== "after",
          ),
        ))
    )
      inertReferenceStores.add(source);
    const byKey =
      replacements.get(receiver.root) ??
      new Map<AmbientReplacementKey, SemanticIterationSource[]>();
    const sources = byKey.get(receiver.key) ?? [];
    sources.push(source);
    byKey.set(receiver.key, sources);
    replacements.set(receiver.root, byKey);
  }
  for (const source of replacementSources) {
    if (
      source.target === undefined ||
      !t.isAssignmentExpression(source.mutation, { operator: "=" })
    )
      continue;
    const key = semanticStaticPropertyKey(
      source.target.property,
      source.target.computed,
    );
    if (
      key !== null &&
      ambientWrites.referenceAssignmentIsBlocked(
        source.target.object,
        key,
        source.mutation,
      )
    )
      inertReferenceStores.add(source);
  }
  // Unknown values require a completed mutation reason, not an unavailable
  // provisional proof. Pure local stores no longer make their RHS escape.
  ownSlotValueUnknown = (owner, key, read) => {
    if (staticObjectOwnProperty(owner, key).status !== "explicit") return false;
    for (const site of activeDescriptorEffects(owner)) {
      if (
        site === read ||
        semanticEffectTiming(read, site, state) === "after" ||
        preservesOwnSlot(owner, site, key, false) ||
        t.isUnaryExpression(site, { operator: "delete" }) ||
        trustedMutation(site)?.mutation.kind === "delete"
      )
        continue;
      if (integrityMutation(site)) continue;
      return true;
    }
    return false;
  };
  completedOwnSlots.set(state, ownSlotUnchanged);
  sourceSlotsComplete = true;
  // Resolve possible identities against one completed store snapshot before
  // publishing any writes. Incremental publication would invalidate loader
  // origin indexes for every target and replay a full source scan each time.
  completedAmbientResolvers.set(state, ambientWrites);
  const targetPaths = targets.map(({ node, capture }) =>
    ambientWrites(node, capture),
  );
  const completedAccessors = createPossibleAccessorMutations(
    state,
    ambientWrites,
    interop,
  );
  for (const { node, path, recipient, valueOnly } of activeWrites) {
    const possibleSource =
      recipient === undefined
        ? undefined
        : accessorMutations.sources.get(recipient.invocation);
    if (
      possibleSource !== undefined &&
      semanticIntrinsicMutation(completedAccessors.invocation(possibleSource))
        ?.receiver !== true
    )
      continue;
    const resolvedTargets =
      path[0] === "pending-target" ? targetPaths[Number(path[1])] : undefined;
    const paths =
      resolvedTargets === undefined
        ? [path]
        : resolvedTargets.map((identity) =>
            canonicalAmbientPath([...identity, ...path.slice(2)]),
          );
    for (const resolved of paths) {
      state.ambientWrites.retain(resolved);
      state.ambientWriteEffects.push({
        path: resolved,
        node,
        ...(valueOnly === undefined ? {} : { valueOnly }),
      });
    }
  }
  const ambientEscapeEffects: AmbientEscapeEffect[] = [];
  for (const { node, paths, browserReceiver, source } of resolvedEscapes) {
    if (source !== undefined && inertReferenceStores.has(source)) continue;
    // A possible setter consumes the stored value. Its mutation possibility
    // belongs to this normalized store, beyond an ordinary ambient escape.
    // Copies carry a source container rather than the individual setter RHS.
    const setterConsumesRhs =
      paths.some((path) => path[0] !== "callable-value") &&
      source?.target !== undefined &&
      source.propertyCopy === undefined &&
      source.propertyWrite !== "define" &&
      storeKinds.get(source) !== "prototype" &&
      ambientWrites.propertySetMayInvokeUserCode(
        source.propertyLookup === undefined
          ? source.target.object
          : source.propertyLookup.target,
        semanticStaticPropertyKey(
          source.target.property,
          source.target.computed,
        ),
        node,
      ) === true;
    for (const path of paths) {
      if (
        path[0] === "callable-value" ||
        (setterConsumesRhs &&
          (isSemanticUnknownReferenceIdentity(path) ||
            semanticSharedStorageHasDescriptorFacts(path)))
      ) {
        const escaped = canonicalAmbientPath([...path, null]);
        state.ambientWrites.retain(escaped);
        state.ambientWriteEffects.push({ path: escaped, node });
      }
      // Only proven browser APIs keep their global receiver from user code.
      if (!(browserReceiver && path.length === 1 && path[0] === "global")) {
        const escaped = canonicalAmbientPath([...path, null]);
        state.ambientEscapes.retain(escaped);
        ambientEscapeEffects.push({ node, path: escaped });
      }
    }
  }
  // A function may call a browser method replaced later in source order.
  if (
    [...browserReceiverMethods].some((method) =>
      state.ambientWrites.covers(["global", method]),
    )
  ) {
    state.ambientEscapes.retain(["global", null]);
    for (const { node, paths, browserReceiver } of resolvedEscapes)
      if (
        browserReceiver &&
        paths.some((path) => path.length === 1 && path[0] === "global")
      )
        ambientEscapeEffects.push({ node, path: ["global", null] });
  }
  completedAmbientEscapeEffects.set(state, ambientEscapeEffects);
  // Opaque callees can be stored after container creation. Resolve them with
  // the completed store facts instead of a second resolver without those facts.
  for (const node of opaqueCalls ?? []) observeOpaqueInvocation?.(node);
  if (
    observeOpaqueInvocation !== undefined ||
    !state.opaqueEffects.mayReferenceGlobalEval
  )
    completeSemanticFreshObjectFacts(state);
}

/**
 * Recognize an ambient property path, optionally through a global object, without a visible
 * source-local overwrite. This is a syntax-local identity fact, not proof that
 * the runtime's globals have never been patched by other code.
 */
export const isUnmodifiedGlobalReference = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string | readonly [string, ...string[]],
): boolean => {
  const path: readonly [string, ...string[]] =
    typeof name === "string" ? [name] : name;
  if (state.ambientWrites.covers(["global", ...path])) return false;
  const { root, members } = electronMemberPath(callee);
  const matches = (expected: readonly string[]) =>
    members.length === expected.length &&
    members.every((key, index) => key === expected[index]);
  if (isUnshadowedGlobal(root, state, path[0]) && matches(path.slice(1)))
    return true;
  const namespace = globalObjectName(root, state);
  return (
    namespace !== undefined &&
    matches(path) &&
    !state.ambientWrites.covers(["global", namespace])
  );
};

/** A module URL base is known only while its property has no visible write. */
export const isUnmodifiedImportMetaUrl = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isImportMetaUrl(node) && !state.ambientWrites.covers(["import-meta", "url"]);
