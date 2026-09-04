/**
 * The composition root's half of ADR 0026: which secret resolver each
 * environment gets, and what the adapters are handed as a result.
 *
 * The point of the first two tests is that a developer machine is unchanged —
 * an environment-only resolver, and an adapter that is configured exactly when
 * the variable the config names holds something.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCostLedger } from "../../src/core/budget.js";
import { buildDependencies } from "../../src/composition.js";
import { KEY_VAULT_URL_ENV } from "../../src/core/secrets.js";
import {
  IDENTITY_ENDPOINT_ENV,
  IDENTITY_HEADER_ENV,
} from "../../src/providers/managed-identity.js";
import { OPENROUTER_ID } from "../../src/providers/openrouter.js";
import type { ImageProvider } from "../../src/providers/types.js";

const VAULT_URL = "https://kv-imagine-test.vault.azure.net/";

const IDENTITY = {
  [IDENTITY_ENDPOINT_ENV]: "http://169.254.169.254/metadata/identity/oauth2/token",
  [IDENTITY_HEADER_ENV]: "header-value",
};

async function dependenciesFor(env: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "imagine-secrets-composition-"));

  return await buildDependencies({
    cwd: directory,
    home: directory,
    env,
    ledger: await openCostLedger({
      budget: { max_usd_per_session: null, max_usd_per_day: null, on_exceed: "refuse" },
      costLog: null,
    }),
  });
}

function openRouterOf(providers: readonly ImageProvider[]): ImageProvider {
  const adapter = providers.find((provider) => provider.id === OPENROUTER_ID);
  if (adapter === undefined) throw new Error("no openrouter adapter was registered");
  return adapter;
}

describe("the secret resolver the composition root builds", () => {
  it("reads the environment and nothing else on a developer machine", async () => {
    const deps = await dependenciesFor({ OPENROUTER_API_KEY: "sk-or-local" });

    expect(deps.secrets?.hasVault).toBe(false);
    expect(await deps.secrets?.resolve(OPENROUTER_ID)).toEqual({
      value: "sk-or-local",
      source: "env",
    });
    expect(openRouterOf(deps.providers).isConfigured()).toBe(true);
  });

  it("leaves an adapter unconfigured when the variable it names is empty", async () => {
    const deps = await dependenciesFor({});

    expect(openRouterOf(deps.providers).isConfigured()).toBe(false);
    expect(await deps.secrets?.resolve(OPENROUTER_ID)).toBeNull();
  });

  it("uses the vault when the deployment names one and an identity can read it", async () => {
    const deps = await dependenciesFor({ ...IDENTITY, [KEY_VAULT_URL_ENV]: VAULT_URL });

    expect(deps.secrets?.hasVault).toBe(true);
    // A vault is a source, so the provider is worth routing to even before a
    // key has been put in it — the failure then names the secret, not the code.
    expect(openRouterOf(deps.providers).isConfigured()).toBe(true);
  });

  it("ignores a vault URL when there is no identity to read the vault with", async () => {
    const deps = await dependenciesFor({ [KEY_VAULT_URL_ENV]: VAULT_URL });

    expect(deps.secrets?.hasVault).toBe(false);
    expect(openRouterOf(deps.providers).isConfigured()).toBe(false);
  });

  it("hands list_capabilities the same resolver the adapters read through", async () => {
    const deps = await dependenciesFor({ OPENROUTER_API_KEY: "sk-or-local" });

    expect(deps.secrets).toBeDefined();
    expect(deps.secrets?.hasSource(OPENROUTER_ID)).toBe(true);
  });
});
