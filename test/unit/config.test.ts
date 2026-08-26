import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isImagineError } from "../../src/core/errors.js";
import {
  DEFAULT_CONFIG,
  availableProviders,
  loadConfig,
  parseEnvFile,
  resolveApiKey,
  type Env,
} from "../../src/core/config.js";

let root: string;
let cwd: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "imagine-config-"));
  cwd = join(root, "project");
  home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".imagine"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeProjectConfig(config: unknown): void {
  writeFileSync(join(cwd, "config.json"), JSON.stringify(config), "utf8");
}

function writeUserConfig(config: unknown): void {
  writeFileSync(join(home, ".imagine", "config.json"), JSON.stringify(config), "utf8");
}

function load(env: Env = {}) {
  return loadConfig({ cwd, home, env });
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(isImagineError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected the call to throw");
}

describe("zero config", () => {
  it("starts on defaults with only OPENROUTER_API_KEY in the environment", () => {
    const loaded = load({ OPENROUTER_API_KEY: "sk-or-zero" });

    expect(loaded.sources).toEqual([]);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(resolveApiKey(loaded, "openrouter")).toBe("sk-or-zero");
    expect(availableProviders(loaded)).toEqual(["openrouter"]);
  });

  it("still loads with no key at all, and reports no available provider", () => {
    const loaded = load();

    expect(loaded.config.default.size).toBe("1024x1024");
    expect(loaded.config.budget.on_exceed).toBe("refuse");
    expect(availableProviders(loaded)).toEqual([]);
  });

  it("leaves every provider but OpenRouter disabled by default", () => {
    expect(DEFAULT_CONFIG.providers.openrouter?.enabled).toBe(true);
    expect(DEFAULT_CONFIG.providers.azure?.enabled).toBe(false);
    expect(DEFAULT_CONFIG.providers.google?.enabled).toBe(false);
    expect(DEFAULT_CONFIG.providers.xai?.enabled).toBe(false);
  });
});

describe("discovery and merge precedence", () => {
  it("merges defaults, then the user config, then the project config", () => {
    writeUserConfig({
      default: { size: "1536x1024" },
      output: { dir: "/user/images" },
      logging: { level: "debug" },
    });
    writeProjectConfig({
      default: { model: "gemini-3.1-flash-image" },
      output: { dir: "./project-images" },
    });

    const { config, sources } = load();

    expect(config.default.model).toBe("gemini-3.1-flash-image");
    expect(config.default.size).toBe("1536x1024");
    expect(config.output.dir).toBe("./project-images");
    expect(config.output.filename).toBe(DEFAULT_CONFIG.output.filename);
    expect(config.logging.level).toBe("debug");
    expect(sources).toEqual([
      join(home, ".imagine", "config.json"),
      join(cwd, "config.json"),
    ]);
  });

  it("merges provider blocks field by field rather than replacing them", () => {
    writeUserConfig({
      providers: {
        azure: {
          enabled: true,
          auth: "api_key",
          endpoint: "https://user.openai.azure.com",
          api_version: "2025-04-01-preview",
          deployments: { "gpt-image-2": "user-deployment" },
        },
      },
    });
    writeProjectConfig({
      providers: {
        azure: { deployments: { "gpt-image-2": "project-deployment" } },
      },
    });

    const { config } = load();
    const azure = config.providers.azure;

    expect(azure?.endpoint).toBe("https://user.openai.azure.com");
    expect(azure?.api_version).toBe("2025-04-01-preview");
    expect(azure?.deployments).toEqual({ "gpt-image-2": "project-deployment" });
    expect(azure?.api_key_env).toBe("AZURE_OPENAI_API_KEY");
  });

  it("accepts an unknown provider block and enables it unless told otherwise", () => {
    writeProjectConfig({ providers: { local: { api_key_env: "LOCAL_KEY" } } });

    const loaded = load({ LOCAL_KEY: "local-secret" });

    expect(loaded.config.providers.local?.enabled).toBe(true);
    expect(resolveApiKey(loaded, "local")).toBe("local-secret");
  });

  it("uses an explicit config path instead of discovery", () => {
    writeProjectConfig({ default: { size: "1024x1536" } });
    const explicit = join(root, "elsewhere.json");
    writeFileSync(explicit, JSON.stringify({ logging: { level: "warn" } }));

    const { config, sources } = loadConfig({
      cwd,
      home,
      env: {},
      configPath: explicit,
    });

    expect(config.logging.level).toBe("warn");
    expect(config.default.size).toBe("1024x1024");
    expect(sources).toEqual([explicit]);
  });

  it("fails loudly when an explicit config path does not exist", () => {
    const missing = join(root, "nope.json");
    const message = messageOf(() =>
      loadConfig({ cwd, home, env: {}, configPath: missing }),
    );

    expect(message).toContain(missing);
    expect(message).toContain("No config file");
  });

  it("ignores the $schema key a config file points at", () => {
    writeProjectConfig({
      $schema: "https://example.test/config.schema.json",
      logging: { level: "error" },
    });

    expect(load().config.logging.level).toBe("error");
  });
});

describe("env files", () => {
  it("reads a .env next to the config", () => {
    writeProjectConfig({});
    writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=sk-or-from-dotenv\n");

    const loaded = load();

    expect(resolveApiKey(loaded, "openrouter")).toBe("sk-or-from-dotenv");
    expect(loaded.envFiles).toEqual([join(cwd, ".env")]);
  });

  it("lets the real environment win over a .env file", () => {
    writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=from-file\n");

    expect(resolveApiKey(load({ OPENROUTER_API_KEY: "from-env" }), "openrouter")).toBe(
      "from-env",
    );
  });

  it("lets the project .env win over the user-level one", () => {
    writeFileSync(join(home, ".imagine", ".env"), "OPENROUTER_API_KEY=user\n");
    writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=project\n");

    const loaded = load();

    expect(resolveApiKey(loaded, "openrouter")).toBe("project");
    expect(loaded.envFiles).toEqual([
      join(home, ".imagine", ".env"),
      join(cwd, ".env"),
    ]);
  });

  it("parses comments, exports, quotes and escapes", () => {
    expect(
      parseEnvFile(
        [
          "# a comment",
          "",
          "PLAIN=value",
          "export EXPORTED = spaced-value ",
          `QUOTED="line\\nbreak"`,
          "SINGLE='raw $value'",
          "TRAILING=value # not part of the value",
          "not a variable line",
        ].join("\n"),
      ),
    ).toEqual({
      PLAIN: "value",
      EXPORTED: "spaced-value",
      QUOTED: "line\nbreak",
      SINGLE: "raw $value",
      TRAILING: "value",
    });
  });
});

describe("key resolution", () => {
  it("reads the key from the environment variable the config names", () => {
    writeProjectConfig({
      providers: { openrouter: { api_key_env: "MY_OWN_KEY_VAR" } },
    });

    expect(resolveApiKey(load({ MY_OWN_KEY_VAR: "sk-custom" }), "openrouter")).toBe(
      "sk-custom",
    );
  });

  it("explains which variable is missing without printing any value", () => {
    const message = messageOf(() =>
      resolveApiKey(load({ OTHER: "sk-secret" }), "openrouter"),
    );

    expect(message).toContain("OPENROUTER_API_KEY");
    expect(message).toContain("api_key_env");
    expect(message).not.toContain("sk-secret");
  });

  it("refuses a disabled provider with a pointer to the field to flip", () => {
    expect(messageOf(() => resolveApiKey(load(), "google"))).toContain(
      "providers.google.enabled",
    );
  });

  it("names the configured providers when asked for an unknown one", () => {
    const message = messageOf(() => resolveApiKey(load(), "midjourney"));

    expect(message).toContain("midjourney");
    expect(message).toContain("openrouter");
  });

  it("needs no key when a provider authenticates through Entra", () => {
    writeProjectConfig({
      providers: {
        azure: {
          enabled: true,
          auth: "entra",
          endpoint: "https://mine.openai.azure.com",
        },
      },
    });
    const loaded = load();

    expect(resolveApiKey(loaded, "azure")).toBeNull();
    expect(availableProviders(loaded)).toContain("azure");
  });

  it("never puts a key value into the config object itself", () => {
    writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=sk-or-secret\n");
    const loaded = load();

    expect(JSON.stringify(loaded.config)).not.toContain("sk-or-secret");
    expect(JSON.stringify(loaded.config)).toContain("OPENROUTER_API_KEY");
  });
});

describe("validation failures", () => {
  it("names the file, the field and what was expected", () => {
    writeProjectConfig({ budget: { on_exceed: "explode" } });
    const message = messageOf(load);

    expect(message).toContain(join(cwd, "config.json"));
    expect(message).toContain("budget.on_exceed");
    expect(message).toContain("refuse");
  });

  it("rejects an unknown key rather than silently ignoring it", () => {
    writeProjectConfig({ output: { directory: "./images" } });
    const message = messageOf(load);

    expect(message).toContain("output");
    expect(message).toContain("directory");
  });

  it("rejects a key value pasted where an env var name belongs", () => {
    writeProjectConfig({
      providers: { openrouter: { api_key_env: "sk-or-v1-abc123" } },
    });
    const message = messageOf(load);

    expect(message).toContain("providers.openrouter.api_key_env");
    expect(message).toContain("NAME of an environment variable");
  });

  it("reports a malformed JSON file as such", () => {
    writeFileSync(join(cwd, "config.json"), '{ "logging": { "level": "info", }');
    const message = messageOf(load);

    expect(message).toContain(join(cwd, "config.json"));
    expect(message).toContain("not valid JSON");
  });

  it("rejects a negative budget", () => {
    writeProjectConfig({ budget: { max_usd_per_day: -1 } });

    expect(messageOf(load)).toContain("budget.max_usd_per_day");
  });

  it("requires an endpoint for an Entra-authenticated provider", () => {
    writeProjectConfig({ providers: { azure: { enabled: true, auth: "entra" } } });
    const message = messageOf(load);

    expect(message).toContain("providers.azure.endpoint");
    expect(message).toContain("Entra");
  });

  it("requires an api_key_env for any other enabled provider", () => {
    writeProjectConfig({
      providers: { google: { enabled: true, api_key_env: null } },
    });
    const message = messageOf(load);

    expect(message).toContain("providers.google.api_key_env");
  });

  it("rejects a non-URL endpoint", () => {
    writeProjectConfig({
      providers: { azure: { enabled: true, endpoint: "my-resource" } },
    });

    expect(messageOf(load)).toContain("providers.azure.endpoint");
  });
});
