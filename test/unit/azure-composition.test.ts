/**
 * The composition root's half of the Azure adapter: config in, a wired adapter
 * out. See ADR 0014 for the seam and ADR 0022 for what fills it.
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

function emptyDirectory(): string {
  return mkdtempSync(join(tmpdir(), "imagine-composition-"));
}

function emptyLedger() {
  return openCostLedger({
    budget: { max_usd_per_session: null, max_usd_per_day: null, on_exceed: "refuse" },
    costLog: null,
  });
}

async function dependenciesFor(
  azure: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  const directory = emptyDirectory();
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({ providers: { azure } }),
    "utf8",
  );

  return await buildDependencies({
    cwd: directory,
    home: directory,
    env,
    ledger: await emptyLedger(),
  });
}

async function generateFailure(adapter: ImageProvider): Promise<ImagineError> {
  const caught = await adapter
    .generate({ prompt: "x" }, { model_ref: "gpt-image-2" })
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
  expect(caught).toBeInstanceOf(ImagineError);
  return caught as ImagineError;
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

  it("refuses an Entra call where the host provides no managed identity", async () => {
    const deps = await dependenciesFor({
      enabled: true,
      auth: "entra",
      endpoint: ENDPOINT,
      deployments: { "gpt-image-2": "my-gpt-image-2" },
    });

    const adapter = azureOf(deps.providers);
    expect(adapter.isConfigured()).toBe(true);

    const failure = await generateFailure(adapter);

    expect(failure.reason).toBe("auth_failed");
    expect(failure.message).toContain("IDENTITY_ENDPOINT");
    expect(failure.message).toContain('"api_key"');
  });

  it("wires the managed identity token provider once the host provides one", async () => {
    const deps = await dependenciesFor(
      {
        enabled: true,
        auth: "entra",
        endpoint: ENDPOINT,
        deployments: { "gpt-image-2": "my-gpt-image-2" },
      },
      {
        IDENTITY_ENDPOINT: "http://127.0.0.1:1/msi/token",
        IDENTITY_HEADER: "identity-header-secret",
      },
    );

    const failure = await generateFailure(azureOf(deps.providers));

    expect(failure.reason).toBe("auth_failed");
    expect(failure.message).toContain("managed identity endpoint");
    expect(failure.message).toContain("http://127.0.0.1:1/msi/token");
  });

  it("takes the whole Azure block from IMAGINE_CONFIG_JSON alone", async () => {
    const deps = await buildDependencies({
      cwd: emptyDirectory(),
      home: emptyDirectory(),
      env: {
        IMAGINE_CONFIG_JSON: JSON.stringify({
          providers: {
            azure: {
              enabled: true,
              auth: "entra",
              endpoint: ENDPOINT,
              deployments: { "gpt-image-2": "hosted-gpt-image-2" },
            },
          },
        }),
        IDENTITY_ENDPOINT: "http://127.0.0.1:1/msi/token",
        IDENTITY_HEADER: "identity-header-secret",
      },
      ledger: await emptyLedger(),
    });

    const adapter = azureOf(deps.providers);

    expect(adapter.isConfigured()).toBe(true);
    expect(await adapter.listModels()).toMatchObject([
      { id: "gpt-image-2", capabilities: { deployment: "hosted-gpt-image-2" } },
    ]);
  });
});
