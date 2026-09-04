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

import type { FailureReason } from "../core/errors.js";
import type { SecretSourceKind } from "../core/secrets.js";
import type { UseCase } from "../core/types.js";
import { CSRF_FIELD } from "./session.js";
import {
  PORTAL_KEYS_PREFIX,
  PORTAL_LOGIN_PATH,
  PORTAL_LOGOUT_PATH,
  PORTAL_PATH,
  PORTAL_STYLE_PATH,
  PORTAL_VERIFY_PREFIX,
} from "./settings.js";

export type ProviderStatus = "ready" | "not_configured" | "disabled";

/** Why a curated model is or is not reachable through the provider listing it. */
export type ModelReach = "ready" | "needs_key" | "needs_deployment" | "needs_enabling";

/** One curated model as it appears under the provider that can serve it. */
export interface ModelRow {
  id: string;
  name: string;
  /** The use cases this model scores highest on, best-first. */
  goodFor: readonly UseCase[];
  perImageUsd: number;
  /** `data/models.json` says the price is derived rather than published. */
  indicativePrice: boolean;
  /** The deployment this provider's config maps the model to, when it names one. */
  deployment: string | null;
  reach: ModelReach;
}

/**
 * The last verification, as a line on the card. The relative time is worked out
 * before rendering, because the page carries no script to work it out with.
 */
export interface VerificationView {
  ok: boolean;
  summary: string;
  /** "3 min ago". */
  relative: string;
  reason: FailureReason | null;
}

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
  /** Curated models this provider can serve, from the knowledge file. */
  models: readonly ModelRow[];
  /**
   * The label of the button that checks the credential, or `null` when there is
   * nothing here to check — "Test key" where a key is stored, "Test access"
   * where the deployment's own identity is the credential.
   */
  testLabel: string | null;
  /** The outcome of the last check, or `null` when none has run. */
  verification: VerificationView | null;
}

/** What `recommend_model` would answer for one use case, as a line on the page. */
export interface UseCasePick {
  useCase: UseCase;
  /** The best model reachable right now, or `null` when nothing is. */
  now: { model: string; provider: string } | null;
  /** The best model ignoring readiness, shown only when it differs from `now`. */
  overall: { model: string; provider: string } | null;
}

export interface DashboardView {
  email: string | null;
  name: string | null;
  subject: string;
  csrf: string;
  providers: readonly ProviderView[];
  picks: readonly UseCasePick[];
  /** The `updated` date of `data/models.json`, so staleness is visible. */
  knowledgeUpdated: string;
  /** A one-line result of the last write, already safe to show. */
  flash: { kind: "ok" | "error"; message: string } | null;
  /** Why no form is offered, when none is. */
  vaultNote: string | null;
}

/** Where an AI client points itself. A path, so it is right on any host. */
const MCP_PATH = "/mcp";
const DOCS_URL = "https://github.com/hoeloe15/imagine#readme";

const USE_CASE_LABELS: Record<UseCase, string> = {
  text_in_image: "text in image",
  photoreal: "photoreal",
  illustration: "illustration",
  diagram: "diagrams",
  fast_bulk: "fast bulk",
};

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

/** Where the key comes from, in three words, next to the status pill. */
function keyChip(provider: ProviderView): string | null {
  if (provider.status === "disabled") return null;
  if (provider.keySource === "vault") return "key from Key Vault";
  if (provider.keySource === "env") return "key from the environment";
  if (provider.status === "ready") return "managed identity";
  return null;
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

/** Three decimals throughout, so the column lines up under tabular figures. */
function money(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

function goodForLine(useCases: readonly UseCase[]): string {
  return useCases.map((useCase) => USE_CASE_LABELS[useCase]).join(", ");
}

function modelPrice(model: ModelRow): string {
  if (!model.indicativePrice) {
    return `<span class="model-price">${money(model.perImageUsd)}</span>`;
  }
  return [
    '<span class="model-price">',
    '<abbr class="approx" title="Indicative: derived or unpublished, not a confirmed list price.">~</abbr>',
    money(model.perImageUsd),
    "</span>",
  ].join("");
}

const WAITING_FOR: Record<Exclude<ModelReach, "ready">, string> = {
  needs_key: "after you add a key",
  needs_enabling: "after you enable it",
  needs_deployment: "no deployment yet",
};

/**
 * The middle column: which deployment serves this model, and what it is still
 * waiting for. Both, when both apply — a deployment that exists but has no key
 * behind it yet is exactly the state the page is there to explain.
 */
function modelMeta(model: ModelRow): string {
  const parts = [
    ...(model.deployment === null
      ? []
      : [`deployment <span class="mono">${escape(model.deployment)}</span>`]),
    ...(model.reach === "ready"
      ? []
      : [`<span class="waiting">${WAITING_FOR[model.reach]}</span>`]),
  ];
  if (parts.length === 0) return "";
  return `<span class="model-meta">${parts.join('<span class="dot"> · </span>')}</span>`;
}

function modelRow(model: ModelRow): string {
  return [
    `<li class="model${model.reach === "ready" ? "" : " model-waiting"}">`,
    '<span class="model-main">',
    `<span class="model-name">${escape(model.name)}</span>`,
    `<span class="model-good">${escape(goodForLine(model.goodFor))}</span>`,
    "</span>",
    modelMeta(model),
    modelPrice(model),
    "</li>",
  ].join("\n");
}

function modelList(provider: ProviderView): string {
  if (provider.models.length === 0) {
    return '<p class="models-empty">No curated model reaches this provider yet.</p>';
  }
  return [
    '<p class="models-head">Models it can serve <span class="model-price-head">per image</span></p>',
    '<ul class="models">',
    ...provider.models.map(modelRow),
    "</ul>",
  ].join("\n");
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

/**
 * A time on the page without a script to compute it: whole units, rounded down,
 * because "3 min ago" is what a person wants and a second's precision is noise.
 */
export function relativeTime(at: Date, now: Date): string {
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Three states, three colours: it worked, the provider refused the credential,
 * or the check found nothing out. The last is amber rather than red because an
 * endpoint that could not be reached says nothing about the key.
 */
function verificationLine(provider: ProviderView): string {
  const check = provider.verification;
  if (check === null) {
    return provider.testLabel === null
      ? ""
      : '<p class="verify unverified">Not verified yet.</p>';
  }

  const detail = `${escape(check.relative)} — ${escape(check.summary)}`;
  if (check.ok) return `<p class="verify verified">Verified ${detail}</p>`;
  if (check.reason === "auth_failed") {
    return `<p class="verify rejected">Rejected ${detail}</p>`;
  }
  return `<p class="verify unproven">Not verified ${detail}</p>`;
}

function verifyForm(provider: ProviderView, csrf: string): string[] {
  if (provider.testLabel === null) return [];
  return [
    `<form method="post" action="${PORTAL_VERIFY_PREFIX}${encodeURIComponent(provider.id)}" class="inline verifyform">`,
    `<input type="hidden" name="${CSRF_FIELD}" value="${escape(csrf)}">`,
    `<button type="submit" class="secondary">${escape(provider.testLabel)}</button>`,
    "</form>",
  ];
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

  const chip = keyChip(provider);
  const verify = verifyForm(provider, view.csrf);
  const act = [...(body === "" ? [] : [body]), ...verify];
  const line = verificationLine(provider);

  return [
    '<section class="provider">',
    '<div class="provider-head">',
    `<h3 class="provider-name">${escape(provider.id)}</h3>`,
    `<span class="status ${provider.status}">${statusLabel(provider.status)}</span>`,
    ...(chip === null ? [] : [`<span class="key-chip">${chip}</span>`]),
    "</div>",
    `<p class="source">${source}</p>`,
    ...(line === "" ? [] : [line]),
    modelList(provider),
    ...(act.length === 0 ? [] : ['<div class="provider-act">', ...act, "</div>"]),
    "</section>",
  ].join("\n");
}

function pickRow(pick: UseCasePick): string {
  const now =
    pick.now === null
      ? '<span class="pick-model none">nothing reachable yet</span>'
      : [
          `<span class="pick-model">${escape(pick.now.model)}</span>`,
          `<span class="pick-via">via ${escape(pick.now.provider)}</span>`,
        ].join("\n");

  const overall =
    pick.overall === null
      ? []
      : [
          `<span class="pick-alt">Best overall: ${escape(pick.overall.model)} — add ${escape(pick.overall.provider)}</span>`,
        ];

  return [
    '<li class="pick">',
    `<span class="pick-case">${escape(USE_CASE_LABELS[pick.useCase])}</span>`,
    now,
    ...overall,
    "</li>",
  ].join("\n");
}

function rail(view: DashboardView): string {
  const anythingReachable = view.picks.some((pick) => pick.now !== null);

  return [
    '<aside class="rail">',
    '<section class="panel">',
    "<h2>Which model for what?</h2>",
    anythingReachable
      ? '<p class="panel-lede">What the server would choose today, per kind of picture.</p>'
      : '<p class="panel-lede">Nothing is reachable yet. Save one key and this fills itself in — here is what each kind of picture is waiting for.</p>',
    '<ul class="picks">',
    ...view.picks.map(pickRow),
    "</ul>",
    "</section>",
    '<section class="panel">',
    "<h2>Point a client here</h2>",
    `<p class="panel-lede">Any MCP client, at <a class="mono" href="${MCP_PATH}">${MCP_PATH}</a> on this host.</p>`,
    `<p class="links"><a href="${DOCS_URL}">Read the documentation</a></p>`,
    "</section>",
    "</aside>",
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
      "<h1>Providers</h1>",
      '<p class="lede">A key you save here is written straight to your Key Vault. It is never shown back to you, in any form — not the last four characters, not its length. The server picks it up <strong>within a minute</strong>: this replica sees it immediately, and any other replica when its cache expires.</p>',
      ...vaultNote,
      "</section>",
      '<div class="layout">',
      '<div class="column">',
      ...view.providers.map((provider) => providerCard(provider, view)),
      "</div>",
      rail(view),
      "</div>",
      '<footer class="foot">',
      '<p class="muted">Budgets, spend and a gallery of everything generated are coming here.</p>',
      `<p class="muted"><span class="approx">~</span> marks an indicative price — derived or unpublished, so confirm it with the provider. Knowledge updated ${escape(view.knowledgeUpdated)}.</p>`,
      "</footer>",
    ].join("\n"),
  );
}

/** Served from its own route so that the CSP can forbid inline styles. */
export const STYLESHEET = `:root {
  color-scheme: dark light;
  --bg: #0b1020;
  --glow-one: rgba(109, 90, 224, 0.22);
  --glow-two: rgba(245, 160, 90, 0.09);
  --panel: rgba(255, 255, 255, 0.045);
  --panel-strong: rgba(255, 255, 255, 0.07);
  --panel-hover: rgba(255, 255, 255, 0.065);
  --line: rgba(255, 255, 255, 0.1);
  --line-soft: rgba(255, 255, 255, 0.055);
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
  --shadow: 0 1rem 2.4rem rgba(4, 7, 18, 0.3);

  --s1: 0.25rem;
  --s2: 0.5rem;
  --s3: 0.75rem;
  --s4: 1rem;
  --s5: 1.5rem;
  --s6: 2rem;
  --s7: 3rem;

  --t-display: 1.7rem;
  --t-head: 1.02rem;
  --t-body: 0.95rem;
  --t-small: 0.82rem;

  --radius: 14px;
  --radius-sm: 9px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f4f1;
    --glow-one: rgba(109, 90, 224, 0.11);
    --glow-two: rgba(245, 160, 90, 0.12);
    --panel: rgba(255, 255, 255, 0.9);
    --panel-strong: #ffffff;
    --panel-hover: #ffffff;
    --line: rgba(27, 32, 51, 0.13);
    --line-soft: rgba(27, 32, 51, 0.07);
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
    --shadow: 0 0.6rem 1.6rem rgba(27, 32, 51, 0.07);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background-color: var(--bg);
  background-image:
    radial-gradient(50rem 26rem at 12% -18%, var(--glow-one), transparent 64%),
    radial-gradient(40rem 22rem at 100% -4%, var(--glow-two), transparent 60%);
  background-repeat: no-repeat;
  color: var(--ink);
  font: var(--t-body)/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main {
  width: 100%;
  max-width: 69rem;
  margin: 0 auto;
  padding: var(--s6) var(--s5) var(--s7);
}
body.centred main {
  max-width: 34rem;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding-block: var(--s7);
}
h1 {
  font-size: var(--t-display);
  line-height: 1.18;
  letter-spacing: -0.022em;
  font-weight: 640;
  margin: var(--s3) 0 0;
  text-wrap: balance;
}
h2 {
  font-size: var(--t-head);
  font-weight: 640;
  letter-spacing: -0.01em;
  margin: 0 0 var(--s2);
}
h3 { font-size: var(--t-head); font-weight: 640; margin: 0; }
p { margin: var(--s2) 0; }
a { color: var(--link); text-underline-offset: 0.2em; }
a:hover { color: var(--ink); }
strong { color: var(--ink); font-weight: 620; }
.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.lede { color: var(--muted); font-size: var(--t-body); max-width: 46rem; }
.muted { color: var(--muted); font-size: var(--t-small); }
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
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
  padding: var(--s6) var(--s5);
  box-shadow: var(--shadow);
}
.hero .actions { margin-top: var(--s5); }
.hero .muted { margin-bottom: 0; }
.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--s4);
  flex-wrap: wrap;
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--line);
}
.who { flex-wrap: wrap; justify-content: flex-end; }
.intro { margin: var(--s6) 0 var(--s5); }
.layout { display: grid; gap: var(--s5); grid-template-areas: "rail" "main"; }
.column { grid-area: main; display: grid; gap: var(--s4); align-content: start; }
.rail { grid-area: rail; display: grid; gap: var(--s4); align-content: start; }
@media (min-width: 62rem) {
  .layout {
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    grid-template-areas: "main rail";
    align-items: start;
  }
  .rail { position: sticky; top: var(--s5); }
}
.provider, .panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--s4) var(--s5) var(--s5);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.provider:hover { border-color: var(--line); background: var(--panel-hover); }
.panel { padding: var(--s4); }
.panel-lede { color: var(--muted); font-size: var(--t-small); margin: 0 0 var(--s3); }
.provider-head {
  display: flex;
  gap: var(--s2);
  align-items: center;
  flex-wrap: wrap;
  padding-bottom: var(--s2);
}
.provider-name { font-variant-ligatures: none; margin-right: var(--s1); }
.key-chip {
  font-size: var(--t-small);
  color: var(--muted);
  margin-left: auto;
}
.source {
  color: var(--muted);
  font-size: var(--t-small);
  margin: 0 0 var(--s4);
  max-width: 44rem;
}
.status {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  padding: 0.14rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
  white-space: nowrap;
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
.verify {
  font-size: var(--t-small);
  margin: 0 0 var(--s4);
  padding-left: var(--s3);
  border-left: 3px solid var(--line);
  color: var(--muted);
}
.verify.verified { border-left-color: var(--good); color: var(--good); }
.verify.rejected { border-left-color: var(--bad); color: var(--bad); }
.verify.unproven { border-left-color: var(--warn); color: var(--warn); }
.verifyform { margin-top: var(--s2); }
.models-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--s3);
  margin: 0;
  padding-bottom: var(--s1);
  border-bottom: 1px solid var(--line);
  font-size: 0.7rem;
  font-weight: 640;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
}
.models-empty { color: var(--muted); font-size: var(--t-small); margin: 0; }
.models { list-style: none; margin: 0; padding: 0; }
.model {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: var(--s3);
  align-items: baseline;
  padding: var(--s2) var(--s1);
  border-bottom: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}
.model:last-child { border-bottom: 0; }
.model:hover { background: var(--panel-strong); }
.model-main {
  grid-column: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s2);
}
.model-name { font-weight: 560; }
.model-good { color: var(--muted); font-size: var(--t-small); }
.model-meta {
  grid-column: 2;
  color: var(--muted);
  font-size: var(--t-small);
  white-space: nowrap;
}
.model-meta .waiting { color: var(--warn); }
.dot { opacity: 0.5; }
.model-price, .model-price-head {
  font-variant-numeric: tabular-nums;
  min-width: 4.6rem;
  text-align: right;
  white-space: nowrap;
}
.model-price { grid-column: 3; font-size: var(--t-small); }
.model-price-head { letter-spacing: 0.1em; }
.model-waiting .model-name, .model-waiting .model-price { opacity: 0.72; }
.approx { color: var(--muted); text-decoration: none; border-bottom: 0; cursor: help; }
.provider-act { margin-top: var(--s4); }
.picks { list-style: none; margin: 0; padding: 0; }
.pick {
  display: grid;
  gap: 0.1rem;
  padding: var(--s2) 0;
  border-top: 1px solid var(--line-soft);
}
.pick:first-child { border-top: 0; padding-top: 0; }
.pick-case {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
}
.pick-model { font-weight: 560; }
.pick-model.none { font-weight: 400; color: var(--muted); }
.pick-via { color: var(--muted); font-size: var(--t-small); }
.pick-alt { color: var(--warn); font-size: var(--t-small); }
form { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; margin: 0; }
.keyform + .inline { margin-top: var(--s2); }
label {
  flex-basis: 100%;
  font-size: var(--t-small);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--muted);
  margin-bottom: -0.2rem;
}
input[type="password"] {
  flex: 1 1 15rem;
  min-width: 0;
  padding: 0.6rem var(--s3);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--field);
  color: inherit;
  font: inherit;
  transition: border-color 0.15s ease;
}
input[type="password"]:hover { border-color: var(--muted); }
input[type="password"]::placeholder { color: var(--muted); }
button, .button {
  padding: 0.6rem var(--s4);
  border-radius: var(--radius-sm);
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
button.secondary:hover { border-color: var(--muted); filter: none; }
:focus-visible {
  outline: 2px solid var(--accent-high);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
.flash {
  margin: var(--s5) 0 0;
  padding: var(--s3) var(--s4);
  border-radius: var(--radius-sm);
  border: 1px solid var(--good);
  border-left-width: 4px;
  background: var(--good-soft);
  color: var(--ink);
  font-size: var(--t-body);
}
.flash.error { border-color: var(--bad); background: var(--bad-soft); }
.note {
  border-left: 3px solid var(--line);
  padding-left: var(--s3);
  color: var(--muted);
  font-size: var(--t-small);
}
.foot {
  margin-top: var(--s6);
  padding-top: var(--s4);
  border-top: 1px solid var(--line);
}
.foot p { margin: var(--s1) 0; }
.links { font-size: var(--t-small); margin: 0; }
@media (max-width: 34rem) {
  main { padding-inline: var(--s4); }
  h1 { font-size: 1.45rem; }
  .card { padding: var(--s5) var(--s4); }
  .provider { padding: var(--s4); }
  .model { grid-template-columns: minmax(0, 1fr) auto; row-gap: var(--s1); }
  .model-main { grid-column: 1; grid-row: 1; }
  .model-price { grid-column: 2; grid-row: 1; }
  .model-meta { grid-column: 1 / -1; grid-row: 2; white-space: normal; }
  input[type="password"] { flex-basis: 100%; }
  .key-chip { margin-left: 0; flex-basis: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  button, .button, .provider, input[type="password"] { transition: none; }
}
`;
