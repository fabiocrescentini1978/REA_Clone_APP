import { z } from "zod";
import { digestSchema } from "../digests.js";
import { analyzeJavaScriptApplicationInputSchema } from "./javascriptApplicationAnalysis.js";
import { localPathStringSchema } from "../localPath.js";
import { jsonObjectSchema } from "../jsonValue.js";

export const javascriptDeobfuscationInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to one UTF-8 JavaScript file; never executed",
  ),
  output_directory: localPathStringSchema.describe(
    "Absolute absent output directory; parent must exist",
  ),
  max_iterations: z.number().int().min(1).max(64).default(16),
});

const fileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: digestSchema,
  bytes: z.number().int().nonnegative(),
});

export const javascriptDeobfuscationResultSchema = z.strictObject({
  source: fileSchema.extend({
    published_copy: fileSchema,
  }),
  options: z.strictObject({
    max_iterations:
      javascriptDeobfuscationInputSchema.shape.max_iterations.removeDefault(),
  }),
  status: z.enum(["changed", "unchanged"]),
  output: fileSchema,
  report: fileSchema,
  manifest: fileSchema,
  diagnostics: jsonObjectSchema.optional(),
  /** Generic binding between the selected source and the published output. */
  proof: z.strictObject({
    input_sha256: digestSchema,
    output_sha256: digestSchema,
  }),
  analysis_input: z.strictObject({
    input_path: analyzeJavaScriptApplicationInputSchema.shape.input_path,
    format: z.literal("directory"),
  }),
  runtime_execution: z.literal("not-performed"),
  limitations: z.array(z.string()),
});

export type JavaScriptDeobfuscationInput = z.output<
  typeof javascriptDeobfuscationInputSchema
>;
export type JavaScriptDeobfuscationResult = z.output<
  typeof javascriptDeobfuscationResultSchema
>;
