import { z } from "incur";
import type { Logger } from "pino";

import { APK_SIGNATURE_PROVIDER_IDENTITY } from "../apkSignature/ApkSignatureRelease.js";
import { apkSignatureModule } from "../composition/apkSignature.js";
import { logCliCommand } from "../cliLogging.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Resolve the caller-selected APK through the shared workflow. */
export const registerApkSignatureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(apkSignatureModule.cliCommand, {
    description:
      "Inspect the signature schemes (v1/v2/v3/v3.1) of a selected local APK/ZIP/AAB",
    args: z.object({
      path: z.string().describe("Local .apk/.zip/.aab artifact to inspect"),
    }),
    options: z.object({}),
    run: ({ args }) =>
      withCommandCancellation((signal) => {
        const service = apkSignatureModule.create(environment);
        return logCliCommand(logger, apkSignatureModule.cliCommand, () =>
          finishAnalysisCommand(
            () =>
              service.inspect(
                { path: absoluteCallerPath(args.path) },
                { signal },
              ),
            service,
            APK_SIGNATURE_PROVIDER_IDENTITY.id,
            apkSignatureModule.contract.name,
            undefined,
            signal,
          ),
        );
      }),
  });
};
