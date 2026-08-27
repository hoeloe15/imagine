/**
 * The composition root's half of the Azure adapter: config in, a wired adapter
 * out. See ADR 0014 for why Entra arrives as a token provider that refuses.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCostLedger } from "../../src/core/budget.js";
import { ImagineError } from "../../src/core/errors.js";
import { buildDependencies } from "../../src/composition.js";
import { AZURE_ID } from "../../src/providers/azure.js";
import type { ImageProvider } from "../../src/providers/types.js";

const ENDPOINT = "https://my-resource.openai.azure.com";

async function dependenciesFor(
  azure: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "imagine-composition-"));
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({ providers: { azure } }),
    "utf8",
  );

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

function azureOf(providers: readonly ImageProvider[]): ImageProvider {
  const adapter = providers.find((provider) => provider.id === AZURE_ID);
  if (adapter === undefined) throw new Error("no azure adapter was registered");
  return adapter;
}

describe("the Azure adapter as the composition root builds it", () => {
  it("is registered even when Azure is switched off", async () => {
    const deps = await dependenciesFor({ enabled: false });

    expect(azureOf(deps.providers).isConfigured()).toBe(false);
  });

  it("is configured from endpoint, key and deployments in api_key mode", async () => {
    const deps = await dependenciesFor(
      {
        enabled: true,
        auth: "api_key",
        api_key_env: "AZURE_OPENAI_API_KEY",
        endpoint: ENDPOINT,
        deployments: { "gpt-image-2": "my-gpt-image-2" },
      },
      { AZURE_OPENAI_API_KEY: "azure-test-key" },
    );

    const adapter = azureOf(deps.providers);

    expect(adapter.isConfigured()).toBe(true);
    expect(await adapter.listModels()).toMatchObject([
      { id: "gpt-image-2", capabilities: { deployment: "my-gpt-image-2" } },
    ]);
  });

  it("is unconfigured while the key variable is unset", async () => {
    const deps = await dependenciesFor({
      enabled: true,
      auth: "api_key",
      api_key_env: "AZURE_OPENAI_API_KEY",
      endpoint: ENDPOINT,
      deployments: { "gpt-image-2": "my-gpt-image-2" },
    });

    expect(azureOf(deps.providers).isConfigured()).toBe(false);
  });

  it("is unconfigured while no deployment is mapped", async () => {
    const deps = await dependenciesFor(
      {
        enabled: true,
        auth: "api_key",
        api_key_env: "AZURE_OPENAI_API_KEY",
        endpoint: ENDPOINT,
      },
      { AZURE_OPENAI_API_KEY: "azure-test-key" },
    );

    expect(azureOf(deps.providers).isConfigured()).toBe(false);
  });

  it("refuses an Entra call with a message naming the issue that owns it", async () => {
    const deps = await dependenciesFor({
      enabled: true,
      auth: "entra",
      endpoint: ENDPOINT,
      deployments: { "gpt-image-2": "my-gpt-image-2" },
    });

    const adapter = azureOf(deps.providers);
    expect(adapter.isConfigured()).toBe(true);

    const failure = await adapter
      .generate({ prompt: "x" }, { model_ref: "gpt-image-2" })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(failure).toBeInstanceOf(ImagineError);
    expect((failure as ImagineError).reason).toBe("auth_failed");
    expect((failure as ImagineError).message).toContain("issue #23");
  });
});
