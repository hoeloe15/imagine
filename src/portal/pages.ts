/**
 * The HTML, hand-written and server-rendered. No framework, no CDN, no inline
 * script — the stylesheet is a route of its own so that the
 * Content-Security-Policy in `portal.ts` can forbid inline anything and still
 * be true.
 *
 * That policy also says `img-src 'self'`, with no `data:`, so there is no image
 * on any page: the lighthouse is an inline `<svg>`, which is markup rather than
 * a fetched resource, and everything else is colour and type from the
 * stylesheet. No element carries a `style` attribute, for the same reason.
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

/** Where an AI client points itself. A path, so it is right on any host. */
const MCP_PATH = "/mcp";
const DOCS_URL = "https://github.com/hoeloe15/imagine#readme";

export function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The lighthouse from the README, drawn rather than loaded: a beam, a tower and
 * a lamp. Inline SVG needs no `img-src` and no round trip; its colours come
 * from the stylesheet.
 */
const MARK = [
  '<svg class="mark" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false">',
  '<path class="mark-beam" d="M15 12 1 6v9zM17 12l14-6v9z"/>',
  '<path class="mark-tower" d="M11 30l2.2-14h5.6L21 30z"/>',
  '<rect class="mark-lamp" x="12.8" y="7" width="6.4" height="7" rx="2"/>',
  '<path class="mark-sill" d="M10.5 15.4h11v1.6h-11z"/>',
  "</svg>",
].join("");

function page(title: string, body: string, bodyClass: string | null = null): string {
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
    bodyClass === null ? "<body>" : `<body class="${bodyClass}">`,
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The brand, as a link on pages that have somewhere to go back to. */
function brand(asLink: boolean): string {
  const inner = `${MARK}<span class="wordmark">imagine</span>`;
  return asLink
    ? `<a class="brand" href="${PORTAL_PATH}">${inner}</a>`
    : `<span class="brand">${inner}</span>`;
}

export function loginPage(): string {
  return page(
    "imagine — sign in",
    [
      '<section class="card hero">',
      brand(false),
      "<h1>Your AI has a hand that can draw.</h1>",
      '<p class="lede">This is the console for that hand: where a provider key goes in, without a terminal and without a deployment. Sign in and it is one field and one button.</p>',
      `<p class="actions"><a class="button" href="${PORTAL_LOGIN_PATH}">Sign in with WorkOS</a></p>`,
      '<p class="muted">Only accounts the owner has allowed can sign in. A key you save lives in your own Azure Key Vault, on your own tenant, and is never shown back to you.</p>',
      "</section>",
    ].join("\n"),
    "centred",
  );
}

export function messagePage(title: string, message: string, back = true): string {
  return page(
    `imagine — ${title}`,
    [
      '<section class="card hero">',
      brand(false),
      `<h1>${escape(title)}</h1>`,
      `<p class="lede">${escape(message)}</p>`,
      ...(back
        ? [
            `<p class="actions"><a class="button" href="${PORTAL_PATH}">Back to the portal</a></p>`,
          ]
        : []),
      "</section>",
    ].join("\n"),
    "centred",
  );
}

function statusLabel(status: ProviderStatus): string {
  if (status === "ready") return "ready";
  if (status === "disabled") return "disabled";
  return "no key yet";
}

function sourceLine(provider: ProviderView): string {
  if (provider.status === "disabled") {
    return provider.note === null
      ? "Disabled in configuration, so nothing is routed to it."
      : escape(provider.note);
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
    `<form method="post" action="${action}" class="keyform">`,
    `<input type="hidden" name="${CSRF_FIELD}" value="${escape(csrf)}">`,
    '<input type="hidden" name="action" value="save">',
    `<label for="${escape(field)}">New key for ${escape(provider.id)}</label>`,
    `<input id="${escape(field)}" name="value" type="password" autocomplete="off" spellcheck="false" required>`,
    '<button type="submit">Save key</button>',
    "</form>",
    ...clear,
  ].join("\n");
}

function providerCard(provider: ProviderView, view: DashboardView): string {
  const source = sourceLine(provider);
  const why = escape(
    provider.note ??
      "This provider's credential cannot be set from here — it authenticates from the deployment's own identity, or there is no Key Vault to write to.",
  );

  // A note that has already been said as the source line is not said twice.
  const body = provider.writable
    ? form(provider, view.csrf)
    : why === source
      ? ""
      : `<p class="muted">${why}</p>`;

  return [
    '<section class="provider">',
    '<h3 class="provider-head">',
    `<span class="name">${escape(provider.id)}</span>`,
    `<span class="status ${provider.status}">${statusLabel(provider.status)}</span>`,
    "</h3>",
    `<p class="source">${source}</p>`,
    ...(body === "" ? [] : [body]),
    "</section>",
  ].join("\n");
}

export function dashboardPage(view: DashboardView): string {
  const who = view.email ?? view.name ?? view.subject;

  const flash =
    view.flash === null
      ? []
      : [
          `<p class="flash ${view.flash.kind}" role="status">${escape(view.flash.message)}</p>`,
        ];

  const vaultNote =
    view.vaultNote === null ? [] : [`<p class="note">${escape(view.vaultNote)}</p>`];

  return page(
    "imagine — providers",
    [
      '<header class="bar">',
      brand(true),
      `<form method="post" action="${PORTAL_LOGOUT_PATH}" class="inline who">`,
      `<input type="hidden" name="${CSRF_FIELD}" value="${escape(view.csrf)}">`,
      `<span class="muted">${escape(who)}</span>`,
      '<button type="submit" class="secondary">Sign out</button>',
      "</form>",
      "</header>",
      ...flash,
      '<section class="intro">',
      "<h2>Providers</h2>",
      '<p class="lede">A key you save here is written straight to your Key Vault. It is never shown back to you, in any form — not the last four characters, not its length. The server picks it up <strong>within a minute</strong>: this replica sees it immediately, and any other replica when its cache expires.</p>',
      ...vaultNote,
      "</section>",
      '<div class="cards">',
      ...view.providers.map((provider) => providerCard(provider, view)),
      "</div>",
      '<footer class="foot">',
      '<p class="muted">Budgets, spend and a gallery of everything generated are coming here.</p>',
      `<p class="links"><a href="${MCP_PATH}">The MCP endpoint</a><span class="dot" aria-hidden="true">·</span><a href="${DOCS_URL}">Documentation</a></p>`,
      "</footer>",
    ].join("\n"),
  );
}

/** Served from its own route so that the CSP can forbid inline styles. */
export const STYLESHEET = `:root {
  color-scheme: dark light;
  --bg: #0b1020;
  --glow-one: rgba(109, 90, 224, 0.34);
  --glow-two: rgba(245, 160, 90, 0.14);
  --panel: rgba(255, 255, 255, 0.05);
  --panel-strong: rgba(255, 255, 255, 0.07);
  --line: rgba(255, 255, 255, 0.11);
  --ink: #eef1f8;
  --muted: #a5aec6;
  --accent: #ff9d4d;
  --accent-high: #ffb877;
  --accent-ink: #24140b;
  --link: #bcaaff;
  --field: rgba(6, 10, 22, 0.55);
  --good: #7fe0b0;
  --good-soft: rgba(127, 224, 176, 0.13);
  --warn: #ffc978;
  --warn-soft: rgba(255, 201, 120, 0.13);
  --bad: #ff9c95;
  --bad-soft: rgba(255, 156, 149, 0.13);
  --radius: 14px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f4f1;
    --glow-one: rgba(109, 90, 224, 0.16);
    --glow-two: rgba(245, 160, 90, 0.18);
    --panel: rgba(255, 255, 255, 0.86);
    --panel-strong: #ffffff;
    --line: rgba(27, 32, 51, 0.14);
    --ink: #1b2033;
    --muted: #5c6480;
    --accent: #c2510d;
    --accent-high: #d96a1f;
    --accent-ink: #fff8f1;
    --link: #5544c8;
    --field: #ffffff;
    --good: #0f6b45;
    --good-soft: rgba(15, 107, 69, 0.1);
    --warn: #8a5a06;
    --warn-soft: rgba(138, 90, 6, 0.1);
    --bad: #a32118;
    --bad-soft: rgba(163, 33, 24, 0.1);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background-color: var(--bg);
  background-image:
    radial-gradient(58rem 30rem at 8% -12%, var(--glow-one), transparent 62%),
    radial-gradient(46rem 26rem at 104% 2%, var(--glow-two), transparent 58%);
  background-repeat: no-repeat;
  color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main {
  width: 100%;
  max-width: 46rem;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
}
body.centred main {
  max-width: 34rem;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding-block: 3rem;
}
h1 {
  font-size: 1.75rem;
  line-height: 1.2;
  letter-spacing: -0.02em;
  margin: 0.9rem 0 0;
  text-wrap: balance;
}
h2 {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--muted);
  margin: 0 0 0.6rem;
}
h3 { font-size: 1rem; margin: 0 0 0.35rem; }
p { margin: 0.6rem 0; }
a { color: var(--link); text-underline-offset: 0.2em; }
strong { color: var(--ink); }
.lede { color: var(--muted); font-size: 0.97rem; }
.muted { color: var(--muted); font-size: 0.9rem; }
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: inherit;
  text-decoration: none;
  font-weight: 620;
  letter-spacing: -0.01em;
}
.wordmark { font-size: 1.05rem; }
.mark { display: block; overflow: visible; }
.mark-beam { fill: var(--accent); opacity: 0.32; }
.mark-tower { fill: var(--ink); opacity: 0.85; }
.mark-sill { fill: var(--ink); opacity: 0.85; }
.mark-lamp { fill: var(--accent); }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.9rem 1.7rem;
  box-shadow: 0 1.4rem 3rem rgba(4, 7, 18, 0.28);
}
.hero .actions { margin-top: 1.4rem; }
.hero .muted { margin-bottom: 0; }
.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding-bottom: 1.4rem;
  border-bottom: 1px solid var(--line);
}
.who { flex-wrap: wrap; justify-content: flex-end; }
.intro { margin: 1.8rem 0 1.4rem; }
.cards { display: grid; gap: 1rem; }
.provider {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.1rem 1.2rem 1.2rem;
}
.provider-head {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  flex-wrap: wrap;
}
.name { font-variant-ligatures: none; }
.source { color: var(--muted); font-size: 0.92rem; margin: 0 0 0.2rem; }
.status {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  padding: 0.14rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
}
.status.ready {
  color: var(--good);
  border-color: var(--good);
  background: var(--good-soft);
}
.status.not_configured {
  color: var(--warn);
  border-color: var(--warn);
  background: var(--warn-soft);
}
form { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
.keyform { margin-top: 0.9rem; }
.inline { margin: 0; }
.keyform + .inline { margin-top: 0.6rem; }
label {
  flex-basis: 100%;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--muted);
  margin-bottom: -0.2rem;
}
input[type="password"] {
  flex: 1 1 15rem;
  min-width: 0;
  padding: 0.62rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  background: var(--field);
  color: inherit;
  font: inherit;
}
input[type="password"]::placeholder { color: var(--muted); }
button, .button {
  padding: 0.62rem 1.1rem;
  border-radius: 0.6rem;
  border: 1px solid transparent;
  background-image: linear-gradient(180deg, var(--accent-high), var(--accent));
  color: var(--accent-ink);
  font: inherit;
  font-weight: 620;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
  transition: filter 0.15s ease, transform 0.15s ease;
}
button:hover, .button:hover { filter: brightness(1.07); }
button:active, .button:active { transform: translateY(1px); }
button.secondary {
  background-image: none;
  background-color: var(--panel-strong);
  border-color: var(--line);
  color: var(--ink);
  font-weight: 550;
}
:focus-visible {
  outline: 2px solid var(--accent-high);
  outline-offset: 2px;
  border-radius: 0.4rem;
}
.flash {
  margin: 1.4rem 0 0;
  padding: 0.8rem 1rem;
  border-radius: 0.7rem;
  border: 1px solid var(--good);
  border-left-width: 4px;
  background: var(--good-soft);
  color: var(--ink);
  font-size: 0.95rem;
}
.flash.error { border-color: var(--bad); background: var(--bad-soft); }
.note {
  border-left: 3px solid var(--line);
  padding-left: 0.9rem;
  color: var(--muted);
  font-size: 0.9rem;
}
.foot {
  margin-top: 2.4rem;
  padding-top: 1.2rem;
  border-top: 1px solid var(--line);
}
.foot p { margin: 0.35rem 0; }
.links { font-size: 0.9rem; }
.dot { padding: 0 0.5rem; color: var(--muted); }
@media (max-width: 30rem) {
  h1 { font-size: 1.5rem; }
  .card { padding: 1.5rem 1.2rem; }
  input[type="password"] { flex-basis: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  button, .button { transition: none; }
}
`;
