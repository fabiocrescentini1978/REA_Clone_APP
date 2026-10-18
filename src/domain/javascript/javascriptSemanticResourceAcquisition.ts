import * as t from "@babel/types";
import {
  readExactJavaScriptNormalResult,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  syntaxEvaluationAlwaysThrows,
  syntaxEvaluationCannotThrow,
} from "./javascriptSymbolicControlFlow.js";

export type JavaScriptResourceAcquisition = "acquired" | "failed" | "unknown";

/** Registration captures a callable disposer; evaluating an object is not registration. */
export const semanticAsyncResourceAcquisition = (
  raw: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptResourceAcquisition => {
  if (syntaxEvaluationAlwaysThrows(raw)) return "failed";
  const node = unwrapJavaScriptExpression(raw).node;
  const normal = readExactJavaScriptNormalResult(
    node,
    syntaxEvaluationCannotThrow,
  );
  if (normal.found) return normal.value == null ? "acquired" : "failed";
  if (isUnshadowedGlobal(node, state, "undefined")) return "acquired";
  if (t.isBigIntLiteral(node)) return "failed";
  if (!t.isObjectExpression(node)) return "unknown";
  // These proofs depend on collected intrinsic/prototype effects. An index
  // still being produced is not proof that the relevant effects are absent.
  state.memberMutationFactsPhase ??= "requested";
  if (state.memberMutationFactsPhase !== "indexed") return "unknown";
  let prototype: "default" | "null" | "unknown" = "default";
  const disposers = new Map<string, t.ObjectProperty | t.ObjectMethod>();
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) return "unknown";
    const key = unwrapJavaScriptExpression(property.key).node;
    const symbol =
      property.computed &&
      t.isMemberExpression(key) &&
      !key.computed &&
      t.isIdentifier(key.property) &&
      ["asyncDispose", "dispose"].includes(key.property.name) &&
      isUnshadowedGlobal(key.object, state, "Symbol") &&
      !state.ambientWrites.covers(["global", "Symbol", key.property.name]) &&
      !state.ambientEscapes.covers(["global", "Symbol", key.property.name]);
    if (!symbol && semanticStaticPropertyKey(key, property.computed) === null)
      return "unknown";
    if (
      t.isObjectProperty(property) &&
      !syntaxEvaluationCannotThrow(property.value)
    )
      return "unknown";
    if (symbol && t.isMemberExpression(key) && t.isIdentifier(key.property))
      disposers.set(key.property.name, property);
    if (
      !property.computed &&
      t.isObjectProperty(property) &&
      !property.shorthand &&
      semanticStaticPropertyKey(key, false) === "__proto__"
    )
      prototype = t.isNullLiteral(property.value) ? "null" : "unknown";
  }
  const inheritedUnknown =
    prototype === "unknown" ||
    (prototype === "default" &&
      (state.ambientWrites.covers(["global", "Object", "prototype", null]) ||
        state.ambientEscapes.covers(["global", "Object", "prototype", null])));
  for (const name of ["asyncDispose", "dispose"]) {
    const method = disposers.get(name);
    if (method === undefined) {
      if (inheritedUnknown) return "unknown";
      continue;
    }
    if (t.isObjectMethod(method))
      return method.kind === "method" ? "acquired" : "unknown";
    const value = unwrapJavaScriptExpression(method.value).node;
    if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))
      return "acquired";
    const result = readExactJavaScriptNormalResult(
      value,
      syntaxEvaluationCannotThrow,
    );
    if (!result.found) return "unknown";
    if (result.value != null) return "failed";
  }
  return "failed";
};

/** Earlier acquired resources survive a later initializer or acquisition failure. */
export const semanticAsyncDeclarationAcquisition = (
  declaration: t.VariableDeclaration,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptResourceAcquisition => {
  // The first registration either contributes a disposal resource, fails
  // before all later declarators, or leaves their applicability unknown.
  const initializer = declaration.declarations[0]?.init;
  return initializer == null
    ? "unknown"
    : semanticAsyncResourceAcquisition(initializer, state);
};
