/**
 * Node module-resolution hook for running the PI-Desktop devkit straight from
 * TypeScript source, without `pnpm install` and without a build step.
 *
 * Two rewrites are needed:
 *
 *   1. TS ESM source writes `./walk.js` while the file on disk is `walk.ts`
 *      (the "rewrite relative import extensions" convention). Node's type
 *      stripping runs .ts happily but does not perform that rewrite.
 *   2. The devkit imports the SDK by its bare workspace name,
 *      `@pi-desktop/plugin-sdk`, which only resolves inside a pnpm workspace.
 *
 * Rewrite (1) only applies when normal resolution fails and the `.ts` sibling
 * actually exists, so a real `.js` file is never shadowed. Both are opt-in and
 * only affect processes that register this hook.
 *
 * Set PI_DESKTOP_SRC to the PI-Desktop checkout to use a different location.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const SDK_SPECIFIER = "@pi-desktop/plugin-sdk";

function sdkEntryUrl() {
  const root =
    process.env.PI_DESKTOP_SRC || "D:/Code/Working-on-it/PI-Desktop-src";
  return pathToFileURL(
    path.join(root, "packages", "plugin-sdk", "src", "index.ts"),
  ).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === SDK_SPECIFIER) {
    return { url: sdkEntryUrl(), shortCircuit: true };
  }

  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isMissingModule = err && err.code === "ERR_MODULE_NOT_FOUND";
    if (isMissingModule && specifier.endsWith(".js")) {
      const asTypeScript = specifier.slice(0, -".js".length) + ".ts";
      return await nextResolve(asTypeScript, context);
    }
    throw err;
  }
}
