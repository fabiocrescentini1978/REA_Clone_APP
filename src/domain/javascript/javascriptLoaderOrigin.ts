import type * as t from "@babel/types";

import { semanticBundledRequireOrigin } from "./javascriptBundledRequireOrigin.js";
import { semanticRequireShimOrigin } from "./javascriptRequireShimOrigin.js";
import {
  semanticRequireOrigin,
  type JavaScriptRequireOrigin,
} from "./javascriptSemanticRequireOrigin.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

/** Reuse each loader owner's proof without interpreting its source again. */
export const semanticLoaderOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined =>
  semanticRequireOrigin(node, state) ??
  semanticBundledRequireOrigin(node, state) ??
  semanticRequireShimOrigin(node, state);
