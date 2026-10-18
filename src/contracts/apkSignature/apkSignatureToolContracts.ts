import {
  apkSignatureResultSchema,
  inspectApkSignatureInputSchema,
} from "../../domain/apkSignature/apkSignatureReport.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static APK signature-scheme inspection of a selected local archive. */
export const INSPECT_APK_SIGNATURE_CONTRACT = {
  name: "inspect_apk_signature",
  ...toolContractMetadata("inspect_apk_signature"),
  kind: "artifact-provider",
  description:
    "Inspect the signing of a selected local Android APK (or ZIP/AAB) statically, to answer who signed it and how before trusting or triaging it. Reports which schemes are present — v1 (JAR META-INF), and the APK Signing Block v2/v3/v3.1 — with each signer's X.509 certificate facts (subject, issuer, serial, validity, public-key algorithm, and the SHA-256 fingerprint of the raw certificate DER), declared digest algorithms, for v1 the certificate each PKCS#7 signature block's SignerInfo names (with the block's certificates and digest/signature algorithm OIDs, or a decode_error), v3 min/max SDK, the declared v3 key-rotation (proof-of-rotation) lineage, and the declared source-stamp certificate. For SHA-256/SHA-512 digests it reports whether the declared content digest matches the current bytes; this is NOT a signature verification, since anyone who changes the bytes can recompute the digest. Derives a posture: v1-only (cannot tell a v1-only APK from one whose v2/v3 block was removed), whether the schemes present the same signer set (observed), whether the v1 signer set equals the lowest block scheme's (observed; a mismatch is notable), whether every differing signer appears in a declared and unverified rotation lineage, the strongest scheme, and rotation/source-stamp presence. No Android code executes; no device or adb is involved; odex/vdex/oat/cdex are not read. No signature is cryptographically verified and no trust verdict is given; SHA-256 identifies the exact bytes, not authenticity.",
  inputSchema: inspectApkSignatureInputSchema,
  outputSchema: evidenceResultOf(apkSignatureResultSchema),
  examples: [
    {
      title: "Identify who signed an APK and under which schemes",
      input: { path: "/artifacts/app.apk" },
    },
  ],
} as const satisfies ToolContract;

/** Keep the public catalog in its existing order, using its named contract. */
export const APK_SIGNATURE_TOOL_CONTRACTS = [
  INSPECT_APK_SIGNATURE_CONTRACT,
] as const;
