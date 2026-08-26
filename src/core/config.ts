/**
 * Config discovery, merging, validation and API-key resolution.
 *
 * Precedence, least to most specific: bundled defaults, `~/.imagine/config.json`,
 * `./config.json`. Environment variables win over any `.env` file, and a `.env`
 * next to a config file wins over one further up the precedence chain.
 *
 * **A key value never enters `Config`.** The config only ever names the
 * environment variable holding a key (`api_key_env`), so the whole object is
 * safe to log; {@link resolveApiKey} is the only thing that touches the value.
 * See ADR 0004.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import { ImagineError } from "./errors.js";
import {
  DEFAULT_CONFIG,
  configFileSchema,
  configSchema,
  type Config,
} from "./config-schema.js";

export { DEFAULT_CONFIG, configFileSchema, configSchema } from "./config-schema.js";
export type {
  Config,
  ConfigFile,
  LogLevel,
  OnBudgetExceeded,
  ProviderAuth,
  ProviderConfig,
} from "./config-schema.js";

export const CONFIG_FILENAME = "config.json";
export const USER_CONFIG_DIR = ".imagine";
export const ENV_FILENAME = ".env";

export type Env = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions {
  /** Where the project-local `config.json` and `.env` are looked for. */
  cwd?: string;
  /** Overrides the home directory used for `~/.imagine/config.json`. */
  home?: string;
  /** The ambient environment. Defaults to `process.env`. */
  env?: Env;
  /**
   * An explicit config file, which replaces discovery entirely. A missing file
   * here is an error, whereas a missing discovered file simply means "no
   * config at this level".
   */
  configPath?: string;
}

export interface LoadedConfig {
  config: Config;
  /** Config files that contributed, least to most specific. Empty is valid. */
  sources: readonly string[];
  /** `.env` files that were loaded, least to most specific. */
  envFiles: readonly string[];
  /** Ambient environment overlaid on the `.env` files; keys are resolved here. */
  env: Env;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const ambient: Env = options.env ?? process.env;

  const candidates = options.configPath
    ? [{ path: resolve(cwd, options.configPath), required: true }]
    : [
        { path: join(home, USER_CONFIG_DIR, CONFIG_FILENAME), required: false },
        { path: join(cwd, CONFIG_FILENAME), required: false },
      ];

  const sources: string[] = [];
  const fragments: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const raw = readIfPresent(candidate.path);
    if (raw === null) {
      if (!candidate.required) continue;
      throw configError(
        `No config file at ${candidate.path}. Create it, or drop the --config option to fall back to ./${CONFIG_FILENAME}, ~/${USER_CONFIG_DIR}/${CONFIG_FILENAME} and the built-in defaults.`,
      );
    }
    sources.push(candidate.path);
    fragments.push(parseFragment(candidate.path, raw));
  }

  const envFiles: string[] = [];
  const fromEnvFiles: Record<string, string> = {};
  for (const dir of envDirs(cwd, home, sources)) {
    const raw = readIfPresent(join(dir, ENV_FILENAME));
    if (raw === null) continue;
    envFiles.push(join(dir, ENV_FILENAME));
    Object.assign(fromEnvFiles, parseEnvFile(raw));
  }
  const env: Env = Object.freeze({ ...fromEnvFiles, ...ambient });

  const merged = fragments.reduce<Record<string, unknown>>(
    (accumulator, fragment) => deepMerge(accumulator, fragment),
    structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
  );

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw configError(
      `${describeSources(sources)} is not valid:\n${formatIssues(result.error.issues)}`,
    );
  }

  return {
    config: result.data,
    sources,
    envFiles,
    env,
  };
}

/**
 * The key for a provider, read from the environment variable the config names.
 * Returns `null` when the provider authenticates without a key (Entra).
 *
 * Throws an {@link ImagineError} rather than returning an empty string, so a
 * missing key surfaces as one actionable message instead of a provider 401.
 */
export function resolveApiKey(loaded: LoadedConfig, providerId: string): string | null {
  const provider = loaded.config.providers[providerId];
  if (!provider) {
    throw new ImagineError(
      "invalid_request",
      `Unknown provider "${providerId}". Configured providers: ${Object.keys(loaded.config.providers).join(", ")}.`,
    );
  }

  if (!provider.enabled) {
    throw new ImagineError(
      "invalid_request",
      `Provider "${providerId}" is disabled. Set providers.${providerId}.enabled to true in ${describeSources(loaded.sources)}.`,
    );
  }

  if (provider.auth === "entra") return null;

  const variable = provider.api_key_env;
  if (!variable) {
    throw new ImagineError(
      "auth_failed",
      `Provider "${providerId}" has no providers.${providerId}.api_key_env, so there is no environment variable to read its key from.`,
    );
  }

  const value = loaded.env[variable];
  if (!value) {
    throw new ImagineError(
      "auth_failed",
      `Environment variable ${variable} is not set, and providers.${providerId}.api_key_env names it as the source of the ${providerId} key. Set it in your environment or in a ${ENV_FILENAME} file next to your config.`,
    );
  }

  return value;
}

/** Enabled providers whose credentials actually resolve, in config order. */
export function availableProviders(loaded: LoadedConfig): string[] {
  return Object.keys(loaded.config.providers).filter((id) => {
    try {
      resolveApiKey(loaded, id);
      return true;
    } catch {
      return false;
    }
  });
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw configError(`Could not read ${path}: ${describeCause(cause)}`, cause);
  }
}

function isNotFound(cause: unknown): boolean {
  const code = (cause as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

function parseFragment(path: string, raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw configError(
      `${path} is not valid JSON: ${describeCause(cause)}. Note that comments and trailing commas are not allowed.`,
      cause,
    );
  }

  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    throw configError(`${path} is not valid:\n${formatIssues(result.error.issues)}`);
  }

  const fragment: Record<string, unknown> = { ...result.data };
  delete fragment["$schema"];
  return fragment;
}

function envDirs(cwd: string, home: string, sources: readonly string[]): string[] {
  const ordered = [
    join(home, USER_CONFIG_DIR),
    ...sources.map((source) => dirname(source)),
    cwd,
  ];
  return ordered.filter((dir, index) => ordered.indexOf(dir) === index);
}

/**
 * `KEY=value` lines, `#` comments, an optional `export ` prefix and optional
 * quotes. Escapes are expanded only inside double quotes, as in a POSIX shell.
 */
export function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const name = match[1] as string;
    const rest = (match[2] ?? "").trim();
    values[name] = unquote(rest);
  }
  return values;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeSources(sources: readonly string[]): string {
  if (sources.length === 0) return "The built-in default configuration";
  if (sources.length === 1) return sources[0] as string;
  return `The configuration merged from ${sources.join(" and ")}`;
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${describePath(issue.path)}: ${issue.message}`)
    .join("\n");
}

function describePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(top level)";
  return path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : index === 0
          ? String(segment)
          : `.${String(segment)}`,
    )
    .join("");
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function configError(message: string, cause?: unknown): ImagineError {
  return new ImagineError("invalid_request", message, { cause });
}
