import * as t from "@babel/types";

import {
  semanticObjectPatternKeys,
  runtimeFunctionParameters,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { JavaScriptSemanticReferenceSource } from "./javascriptSemanticReferenceSources.js";
import {
  semanticIntrinsicMutation,
  type JavaScriptIntrinsicMutationRecipient,
} from "./javascriptElectronMemberWrites.js";

type IterationSourceValue = JavaScriptSemanticReferenceSource;

/** An iterator receiver or property reference store, with default guards. */
export interface SemanticIterationSource extends IterationSourceValue {
  readonly kind: "iteration" | "reference-store";
  readonly mutation: t.Node;
  readonly target?: t.MemberExpression;
  readonly fallbackSources?: readonly IterationSourceValue[];
  readonly requiredSources?: readonly IterationSourceValue[];
  /** Copy the selected target key from one own source slot, preserving its name. */
  readonly propertyCopy?: "value" | "descriptor";
  /** A descriptor getter stores the value returned when its property is read. */
  readonly invocationResult?: true;
  /** Definitions bypass setters; assignments and value copies use [[Set]]. */
  readonly propertyWrite?: "define" | "set";
  /** Reflect.set starts descriptor lookup here and writes target.object. */
  readonly propertyLookup?: { readonly target: t.Node | undefined };
}

/** Parsed data mutators feed the same reference graph as assignment stores. */
export const semanticIntrinsicDataStores = (
  recipient: JavaScriptIntrinsicMutationRecipient,
  mutationSite: t.Node,
  staticString: (node: t.Node | undefined) => string | undefined,
): readonly SemanticIterationSource[] => {
  const target = recipient.target;
  if (!t.isExpression(target)) return [];
  const mutation = semanticIntrinsicMutation(recipient.invocation);
  if (mutation?.kind === "assign" || mutation?.kind === "define-properties") {
    const args = recipient.invocation.arguments;
    const values =
      mutation.kind === "assign" ? args?.slice(1) : args?.slice(1, 2);
    return (values ?? []).flatMap((source) =>
      t.isNode(source) && !t.isSpreadElement(source)
        ? [
            {
              kind: "reference-store" as const,
              node: source,
              projection: [],
              mutation: mutationSite,
              propertyWrite:
                mutation.kind === "assign"
                  ? ("set" as const)
                  : ("define" as const),
              target: t.memberExpression(
                target,
                t.identifier("copiedProperty"),
                true,
              ),
              propertyCopy:
                mutation.kind === "assign"
                  ? ("value" as const)
                  : ("descriptor" as const),
            },
            ...(mutation.kind === "define-properties"
              ? [
                  {
                    kind: "reference-store" as const,
                    node: source,
                    projection: [],
                    mutation: mutationSite,
                    propertyWrite: "define" as const,
                    target: t.memberExpression(
                      target,
                      t.identifier("copiedProperty"),
                      true,
                    ),
                    propertyCopy: "descriptor" as const,
                    invocationResult: true as const,
                  },
                ]
              : []),
          ]
        : [],
    );
  }
  if (mutation?.kind !== "define-property" && mutation?.kind !== "set")
    return [];
  if (mutation.accessor === "set") return [];
  const source = recipient.invocation.arguments?.[mutation.receiver ? 1 : 2];
  if (!t.isNode(source) || t.isSpreadElement(source)) return [];
  const key = staticString(mutation.key);
  const property = key === undefined ? mutation.key : t.stringLiteral(key);
  if (!t.isExpression(property)) return [];
  const store = {
    kind: "reference-store" as const,
    node: source,
    mutation: mutationSite,
    propertyWrite:
      mutation.kind === "define-property"
        ? ("define" as const)
        : ("set" as const),
    ...(mutation.kind === "set"
      ? { propertyLookup: { target: recipient.invocation.arguments?.[0] } }
      : {}),
    target: t.memberExpression(target, property, true),
  };
  if (mutation.accessor === "get")
    return [{ ...store, projection: [], invocationResult: true }];
  return [
    {
      ...store,
      projection: mutation.kind === "define-property" ? ["value"] : [],
    },
    ...(mutation.kind === "define-property"
      ? [{ ...store, projection: ["get"], invocationResult: true as const }]
      : []),
  ];
};

interface PatternSource extends IterationSourceValue {
  // A rest binding is a fresh array whose children retain their source indices.
  readonly restStartIndex?: number;
}

interface SourceGuards {
  readonly fallbackSources?: readonly IterationSourceValue[];
  readonly requiredSources?: readonly IterationSourceValue[];
}

const add = (
  sources: SemanticIterationSource[],
  source: IterationSourceValue,
  mutation: t.Node,
  guards: SourceGuards,
  kind: SemanticIterationSource["kind"] = "iteration",
  target?: t.MemberExpression,
): void => {
  sources.push({
    kind,
    node: source.node,
    projection: source.projection,
    mutation,
    ...guards,
    ...(target === undefined ? {} : { target }),
  });
};
const project = (
  source: PatternSource | undefined,
  key: string | number | null,
): PatternSource | undefined => {
  if (source === undefined) return undefined;
  const index = key === null ? null : semanticArrayIndex(key);
  return {
    node: source.node,
    projection: [
      ...source.projection,
      source.restStartIndex !== undefined && index !== null
        ? source.restStartIndex + index
        : key,
    ],
  };
};
interface PatternCollection {
  readonly sources: SemanticIterationSource[];
  readonly mutation: t.Node;
}

const visit = (
  context: PatternCollection,
  pattern: t.Node,
  source: PatternSource | undefined,
  guards: SourceGuards = {},
): void => {
  const { sources, mutation } = context;
  if (t.isMemberExpression(pattern)) {
    // Property stores have no lexical alias binding. Preserve the selected
    // reference's escape rather than claiming later writes cannot reach it.
    if (source !== undefined)
      add(
        sources,
        source.restStartIndex === undefined
          ? source
          : {
              node: source.node,
              projection: [
                ...source.projection,
                { excludedKeys: [], startIndex: source.restStartIndex },
              ],
            },
        mutation,
        guards,
        "reference-store",
        pattern,
      );
    return;
  }
  if (t.isTSParameterProperty(pattern)) {
    visit(context, pattern.parameter, source, guards);
    return;
  }
  if (t.isAssignmentPattern(pattern)) {
    visit(context, pattern.left, source, {
      ...guards,
      requiredSources: [
        ...(guards.requiredSources ?? []),
        ...(source === undefined ? [] : [{ ...source, selection: pattern }]),
      ],
    });
    visit(
      context,
      pattern.left,
      { node: pattern.right, projection: [] },
      {
        ...guards,
        fallbackSources: [
          ...(guards.fallbackSources ?? []),
          ...(source === undefined ? [] : [{ ...source, selection: pattern }]),
        ],
      },
    );
    return;
  }
  if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) {
        // A rest copy owns its scalar slots; only selected child references
        // escape when that fresh copy is stored through a member target.
        visit(
          context,
          property.argument,
          source === undefined
            ? undefined
            : {
                node: source.node,
                projection: [
                  ...source.projection,
                  {
                    excludedKeys: [
                      ...new Set(semanticObjectPatternKeys(pattern)),
                    ].sort(compareUnicodeCodePoints),
                  },
                ],
              },
          guards,
        );
        continue;
      }
      visit(
        context,
        property.value,
        project(
          source,
          semanticStaticPropertyKey(property.key, property.computed),
        ),
        guards,
      );
    }
    return;
  }
  if (t.isArrayPattern(pattern)) {
    if (source !== undefined && source.restStartIndex === undefined)
      add(sources, source, mutation, guards);
    pattern.elements.forEach((element, index) => {
      if (element === null) return;
      if (t.isRestElement(element))
        visit(
          context,
          element.argument,
          source === undefined
            ? undefined
            : {
                node: source.node,
                projection: source.projection,
                restStartIndex: (source.restStartIndex ?? 0) + index,
              },
          guards,
        );
      else visit(context, element, project(source, index), guards);
    });
    return;
  }
  if (t.isRestElement(pattern))
    visit(context, pattern.argument, undefined, guards);
};

/** Describe iterator receivers and property reference stores without evaluation. */
export const semanticIterationSources = (
  node: t.Node,
  parent: t.Node | null,
): readonly SemanticIterationSource[] => {
  const sources: SemanticIterationSource[] = [];
  const context = { sources, mutation: node };
  if (t.isVariableDeclarator(node) && node.init != null)
    visit(context, node.id, { node: node.init, projection: [] });
  else if (
    t.isAssignmentExpression(node) &&
    ["=", "||=", "&&=", "??="].includes(node.operator)
  )
    visit(context, node.left, { node: node.right, projection: [] });
  else if (t.isForOfStatement(node)) {
    add(sources, { node: node.right, projection: [] }, node, {});
    const source = { node: node.right, projection: [null] };
    if (t.isVariableDeclaration(node.left)) {
      for (const declaration of node.left.declarations)
        visit(context, declaration.id, source);
    } else visit(context, node.left, source);
  } else if (t.isSpreadElement(node) && t.isArrayExpression(parent))
    add(sources, { node: node.argument, projection: [] }, node, {});
  else if (t.isYieldExpression(node) && node.delegate && node.argument != null)
    add(sources, { node: node.argument, projection: [] }, node, {});
  else if (t.isFunction(node))
    for (const parameter of runtimeFunctionParameters(node))
      visit(context, parameter, undefined);

  return sources;
};
