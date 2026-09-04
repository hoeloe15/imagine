/**
 * The HTML, hand-written and server-rendered. No framework, no CDN, no inline
 * script — the stylesheet is a route of its own so that the
 * Content-Security-Policy in `portal.ts` can forbid inline anything and still
 * be true.
 *
 * Everything that came from outside this process goes through {@link escape}.
 * Nothing on any page is a secret value: a key field is write-only, and what is
 * shown is presence, source and the *name* of the place a key would live.
 */

import type { SecretSourceKind } from "../core/secrets.js";
import { CSRF_FIELD } from "./session.js";
import {
  PORTAL_KEYS_PREFIX,
  PORTAL_LOGIN_PATH,
  PORTAL_LOGOUT_PATH,
  PORTAL_PATH,
  PORTAL_STYLE_PATH,
} from "./settings.js";

export type ProviderStatus = "ready" | "not_configured" | "disabled";

export interface ProviderView {
  id: string;
  status: ProviderStatus;
  keySource: SecretSourceKind | null;
  /** The Key Vault secret a key would be written to, when there is a vault. */
  secretName: string | null;
  envVar: string | null;
  /** Whether this page can write this provider's key at all. */
  writable: boolean;
  note: string | null;
}

export interface DashboardView {
  email: string | null;
  name: string | null;
  subject: string;
  csrf: string;
  providers: readonly ProviderView[];
  /** A one-line result of the last write, already safe to show. */
  flash: { kind: "ok" | "error"; message: string } | null;
  /** Why no form is offered, when none is. */
  vaultNote: string | null;
}

export function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escape(title)}</title>`,
    `<link rel="stylesheet" href="${PORTAL_STYLE_PATH}">`,
    "</head>",
    "<body>",
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function loginPage(): string {
  return page(
    "imagine — sign in",
    [
      "<h1>imagine</h1>",
      "<p>This is the console for your own toolbox: where a provider key goes in, without a terminal and without a deployment.</p>",
      `<p><a class="button" href="${PORTAL_LOGIN_PATH}">Sign in with WorkOS</a></p>`,
      '<p class="muted">Only accounts the owner has allowed can sign in. Everything on the next page is stored in your own Azure Key Vault.</p>',
    ].join("\n"),
  );
}

export function messagePage(title: string, message: string, back = true): string {
  return page(
    `imagine — ${title}`,
    [
      `<h1>${escape(title)}</h1>`,
      `<p>${escape(message)}</p>`,
      ...(back ? [`<p><a href="${PORTAL_PATH}">Back to the portal</a></p>`] : []),
    ].join("\n"),
  );
}

function statusLabel(status: ProviderStatus): string {
  if (status === "ready") return "ready";
  if (status === "disabled") return "disabled";
  return "no key yet";
}

function sourceLine(provider: ProviderView): string {
  if (provider.status === "disabled") {
    return "Disabled in configuration, so nothing is routed to it.";
  }
  if (provider.keySource === "vault") {
    return `Its key comes from Key Vault, as the secret ${escape(provider.secretName ?? "")}.`;
  }
  if (provider.keySource === "env") {
    return `Its key comes from the environment variable ${escape(provider.envVar ?? "")}, which the deployment set.`;
  }
  return provider.note === null
    ? "No key has been set for it yet."
    : escape(provider.note);
}

function form(provider: ProviderView, csrf: string): string {
  const action = `${PORTAL_KEYS_PREFIX}${encodeURIComponent(provider.id)}`;
  const field = `key-${provider.id}`;

  const clear =
    provider.keySource === "vault"
      ? [
          `<form method="post" action="${action}" class="inline">`,
          `<input type="hidden" name="${CSRF_FIELD}" value="${escape(csrf)}">`,
          '<input type="hidden" name="action" value="clear">',
          '<button type="submit" class="secondary">Clear the stored key</button>',
          "</form>",
        ]
      : [];

  return [
    `<form method="post" action="${action}">`,
    `<input type="hidden" name="${CSRF_FIELD}" value="${escape(csrf)}">`,
    '<input type="hidden" name="action" value="save">',
    `<label for="${escape(field)}">New key for ${escape(provider.id)}</label>`,
    `<input id="${escape(field)}" name="value" type="password" autocomplete="off" spellcheck="false" required>`,
    '<button type="submit">Save</button>',
    "</form>",
    ...clear,
  ].join("\n");
}

function providerCard(provider: ProviderView, view: DashboardView): string {
  const body = provider.writable
    ? form(provider, view.csrf)
    : `<p class="muted">${escape(
        provider.note ??
          "This provider's credential cannot be set from here — it authenticates from the deployment's own identity, or there is no Key Vault to write to.",
      )}</p>`;

  return [
    '<section class="provider">',
    "<h3>",
    escape(provider.id),
    `<span class="status ${provider.status}">${statusLabel(provider.status)}</span>`,
    "</h3>",
    `<p>${sourceLine(provider)}</p>`,
    body,
    "</section>",
  ].join("\n");
}

export function dashboardPage(view: DashboardView): string {
  const who = view.email ?? view.name ?? view.subject;

  const flash =
    view.flash === null
      ? []
      : [`<p class="flash ${view.flash.kind}">${escape(view.flash.message)}</p>`];

  const vaultNote =
    view.vaultNote === null ? [] : [`<p class="muted">${escape(view.vaultNote)}</p>`];

  return page(
    "imagine — providers",
    [
      '<header class="bar">',
      "<h1>imagine</h1>",
      `<form method="post" action="${PORTAL_LOGOUT_PATH}" class="inline">`,
      `<input type="hidden" name="${CSRF_FIELD}" value="${escape(view.csrf)}">`,
      `<span class="muted">${escape(who)}</span>`,
      '<button type="submit" class="secondary">Sign out</button>',
      "</form>",
      "</header>",
      ...flash,
      "<h2>Providers</h2>",
      "<p>A key you save here is written straight to your Key Vault. It is never shown back to you, in any form — not the last four characters, not its length. The server picks it up <strong>within a minute</strong>: this replica sees it immediately, and any other replica when its cache expires.</p>",
      ...vaultNote,
      ...view.providers.map((provider) => providerCard(provider, view)),
    ].join("\n"),
  );
}

/** Served from its own route so that the CSP can forbid inline styles. */
export const STYLESHEET = `:root {
  color-scheme: light dark;
  --ink: #16181d;
  --paper: #fbfbfa;
  --muted: #5d6470;
  --line: #d9dbe0;
  --accent: #2f5bd7;
  --bad: #a3231f;
  --good: #1d6a3f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #eceef2;
    --paper: #16181d;
    --muted: #a2a9b6;
    --line: #333844;
    --accent: #8fa9f2;
    --bad: #f0938f;
    --good: #7fd0a2;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.35rem; margin: 0; }
h2 { font-size: 1.05rem; margin: 2rem 0 0.5rem; }
h3 { font-size: 1rem; margin: 0 0 0.35rem; display: flex; gap: 0.6rem; align-items: baseline; }
p { margin: 0.5rem 0; }
a { color: var(--accent); }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.muted { color: var(--muted); font-size: 0.9rem; }
.inline { display: flex; gap: 0.6rem; align-items: center; margin: 0; }
.provider { border: 1px solid var(--line); border-radius: 0.5rem; padding: 1rem; margin: 1rem 0; }
.status { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.1rem 0.45rem; border-radius: 0.25rem; border: 1px solid var(--line); color: var(--muted); }
.status.ready { color: var(--good); border-color: var(--good); }
form { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-top: 0.75rem; }
label { flex-basis: 100%; font-size: 0.85rem; color: var(--muted); }
input[type="password"] { flex: 1 1 16rem; padding: 0.5rem 0.6rem; border: 1px solid var(--line); border-radius: 0.35rem; background: transparent; color: inherit; font: inherit; }
button, .button {
  padding: 0.5rem 0.9rem; border-radius: 0.35rem; border: 1px solid var(--accent);
  background: var(--accent); color: #fff; font: inherit; cursor: pointer; text-decoration: none;
  display: inline-block;
}
button.secondary { background: transparent; color: var(--accent); }
.flash { border-radius: 0.35rem; padding: 0.65rem 0.8rem; border: 1px solid var(--good); color: var(--good); }
.flash.error { border-color: var(--bad); color: var(--bad); }
`;
