/**
 * The dashboard's markup, rendered straight from a view object: the model list
 * under each provider, the per-use-case picks, and the promises the
 * Content-Security-Policy in `portal.ts` relies on — no inline style, no inline
 * script, no external resource.
 */

import { describe, expect, it } from "vitest";
import {
  dashboardPage,
  loginPage,
  messagePage,
  relativeTime,
  STYLESHEET,
  type DashboardView,
  type ModelRow,
  type ProviderView,
} from "../../src/portal/pages.js";

function model(over: Partial<ModelRow> = {}): ModelRow {
  return {
    id: "lantern-1",
    name: "Lantern 1",
    goodFor: ["text_in_image"],
    perImageUsd: 0.19,
    indicativePrice: true,
    deployment: null,
    reach: "ready",
    ...over,
  };
}

function provider(over: Partial<ProviderView> = {}): ProviderView {
  return {
    id: "azure",
    status: "ready",
    keySource: "vault",
    secretName: "azure-api-key",
    envVar: "AZURE_OPENAI_API_KEY",
    writable: true,
    note: null,
    models: [model()],
    testLabel: "Test key",
    verification: null,
    ...over,
  };
}

function view(over: Partial<DashboardView> = {}): DashboardView {
  return {
    email: "owner@example.com",
    name: null,
    subject: "user_01",
    csrf: "token",
    providers: [provider()],
    picks: [
      {
        useCase: "text_in_image",
        now: { model: "Lantern 1", provider: "azure" },
        overall: null,
      },
    ],
    knowledgeUpdated: "2026-09-04",
    flash: null,
    vaultNote: null,
    ...over,
  };
}

describe("the model list under a provider", () => {
  it("gives each model a name, a good-for line and a price", () => {
    const html = dashboardPage(view());

    expect(html).toContain("Lantern 1");
    expect(html).toContain("text in image");
    expect(html).toContain("$0.190");
  });

  it("joins several equal-best use cases into one good-for line", () => {
    const html = dashboardPage(
      view({
        providers: [
          provider({ models: [model({ goodFor: ["photoreal", "illustration"] })] }),
        ],
      }),
    );

    expect(html).toContain("photoreal, illustration");
  });

  it("marks an indicative price and leaves a confirmed one unmarked", () => {
    const indicative = dashboardPage(view());
    const confirmed = dashboardPage(
      view({
        providers: [provider({ models: [model({ indicativePrice: false })] })],
      }),
    );

    expect(indicative).toContain('class="approx"');
    expect(confirmed).not.toContain('class="approx" title=');
  });

  it("names the deployment a model maps to, and says when there is none", () => {
    const html = dashboardPage(
      view({
        providers: [
          provider({
            models: [
              model({ deployment: "lantern-prod" }),
              model({ id: "harbour-2", name: "Harbour 2", reach: "needs_deployment" }),
            ],
          }),
        ],
      }),
    );

    expect(html).toContain('deployment <span class="mono">lantern-prod</span>');
    expect(html).toContain("no deployment yet");
  });

  it("shows a deployment and its missing key together, not one instead of the other", () => {
    const html = dashboardPage(
      view({
        providers: [
          provider({
            status: "not_configured",
            keySource: null,
            models: [model({ deployment: "lantern-prod", reach: "needs_key" })],
          }),
        ],
      }),
    );

    expect(html).toContain("lantern-prod");
    expect(html).toContain("after you add a key");
  });

  it("says a disabled provider's models wait on the configuration, not on a key", () => {
    const html = dashboardPage(
      view({
        providers: [
          provider({
            status: "disabled",
            keySource: null,
            writable: false,
            models: [model({ reach: "needs_enabling" })],
          }),
        ],
      }),
    );

    expect(html).toContain("after you enable it");
    expect(html).not.toContain("after you add a key");
  });

  it("says so plainly when no curated model reaches a provider", () => {
    const html = dashboardPage(view({ providers: [provider({ models: [] })] }));
    expect(html).toContain("No curated model reaches this provider yet");
  });
});

describe("the verification line on a card", () => {
  it("offers the test and says nothing has been checked yet", () => {
    const html = dashboardPage(view());

    expect(html).toContain('action="/portal/verify/azure"');
    expect(html).toContain(">Test key<");
    expect(html).toContain("Not verified yet");
  });

  it("calls it testing access where the identity is the credential", () => {
    const html = dashboardPage(
      view({ providers: [provider({ writable: false, testLabel: "Test access" })] }),
    );

    expect(html).toContain(">Test access<");
  });

  it("stamps a success with how long ago it was and what was seen", () => {
    const html = dashboardPage(
      view({
        providers: [
          provider({
            verification: {
              ok: true,
              summary: "31 image models visible",
              relative: "3 min ago",
              reason: null,
            },
          }),
        ],
      }),
    );

    expect(html).toContain("Verified 3 min ago — 31 image models visible");
    expect(html).toContain('class="verify verified"');
  });

  it("says rejected, in red, when the provider refused the credential", () => {
    const html = dashboardPage(
      view({
        providers: [
          provider({
            verification: {
              ok: false,
              summary: "invalid key (401)",
              relative: "3 min ago",
              reason: "auth_failed",
            },
          }),
        ],
      }),
    );

    expect(html).toContain("Rejected 3 min ago — invalid key (401)");
    expect(html).toContain('class="verify rejected"');
  });

  it("separates a check that found nothing out from one that failed", () => {
    const html = dashboardPage(
      view({
        providers: [
          provider({
            verification: {
              ok: false,
              summary: "the provider could not be reached",
              relative: "1 hour ago",
              reason: "provider_unavailable",
            },
          }),
        ],
      }),
    );

    expect(html).toContain("Not verified 1 hour ago");
    expect(html).toContain('class="verify unproven"');
    expect(html).not.toContain("Rejected");
  });

  it("offers no button and no line where there is nothing to test", () => {
    const html = dashboardPage(
      view({ providers: [provider({ testLabel: null, writable: false })] }),
    );

    expect(html).not.toContain("/portal/verify/");
    expect(html).not.toContain("Not verified yet");
  });

  it("escapes a summary, which comes from outside this process", () => {
    const html = dashboardPage(
      view({
        providers: [
          provider({
            verification: {
              ok: false,
              summary: '<script>alert("x")</script>',
              relative: "just now",
              reason: "unknown",
            },
          }),
        ],
      }),
    );

    expect(html).not.toContain("<script");
  });
});

describe("relative time, rendered by the server because there is no script", () => {
  const at = new Date("2026-09-04T12:00:00.000Z");
  const after = (seconds: number): Date => new Date(at.getTime() + seconds * 1000);

  it("rounds down to whole units a person would say", () => {
    expect(relativeTime(at, after(5))).toBe("just now");
    expect(relativeTime(at, after(60))).toBe("1 min ago");
    expect(relativeTime(at, after(3 * 60 + 40))).toBe("3 min ago");
    expect(relativeTime(at, after(60 * 60))).toBe("1 hour ago");
    expect(relativeTime(at, after(5 * 60 * 60))).toBe("5 hours ago");
    expect(relativeTime(at, after(50 * 60 * 60))).toBe("2 days ago");
  });

  it("does not say a check happened in the future", () => {
    expect(relativeTime(at, after(-90))).toBe("just now");
  });
});

describe("the which-model-for-what panel", () => {
  it("names the reachable pick and the provider it goes through", () => {
    const html = dashboardPage(view());
    expect(html).toContain("Which model for what?");
    expect(html).toContain("via azure");
  });

  it("invites a key when nothing is reachable, naming what it would unlock", () => {
    const html = dashboardPage(
      view({
        picks: [
          {
            useCase: "photoreal",
            now: null,
            overall: { model: "Harbour 2", provider: "azure" },
          },
        ],
      }),
    );

    expect(html).toContain("nothing reachable yet");
    expect(html).toContain("Best overall: Harbour 2 — add azure");
    expect(html).toContain("Save one key and this fills itself in");
  });
});

describe("honesty about the knowledge file", () => {
  it("dates the knowledge in the footer and explains the indicative marker", () => {
    const html = dashboardPage(view({ knowledgeUpdated: "2026-09-04" }));
    expect(html).toContain("Knowledge updated 2026-09-04");
    expect(html).toContain("marks an indicative price");
  });
});

describe("what the Content-Security-Policy is allowed to forbid", () => {
  const pages = [
    loginPage(),
    messagePage("Nope", "Nothing here."),
    dashboardPage(view()),
  ];

  it("carries no inline style attribute and no inline style block", () => {
    for (const html of pages) {
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toContain("<style");
    }
  });

  it("carries no script at all", () => {
    for (const html of pages) expect(html).not.toContain("<script");
  });

  it("loads nothing from another origin but its own stylesheet route", () => {
    for (const html of pages) {
      expect(html).not.toContain("<img");
      expect(html).toContain('href="/portal/style.css"');
    }
  });
});

describe("escaping", () => {
  it("escapes a provider id, a deployment name and the knowledge date", () => {
    const html = dashboardPage(
      view({
        knowledgeUpdated: '2026<script>"',
        providers: [
          provider({
            id: "ev<il>",
            models: [model({ deployment: 'dep"loy<ment' })],
          }),
        ],
      }),
    );

    expect(html).not.toContain("<script");
    expect(html).toContain("ev&lt;il&gt;");
    expect(html).toContain("dep&quot;loy&lt;ment");
  });
});

describe("the stylesheet", () => {
  it("keeps a light scheme and states the dark one first", () => {
    expect(STYLESHEET).toContain("color-scheme: dark light");
    expect(STYLESHEET).toContain("@media (prefers-color-scheme: light)");
  });

  it("aligns the price column with tabular figures", () => {
    expect(STYLESHEET).toContain("font-variant-numeric: tabular-nums");
  });

  it("fetches no font and no image from anywhere", () => {
    expect(STYLESHEET).not.toContain("@import");
    expect(STYLESHEET).not.toContain("url(");
  });
});
