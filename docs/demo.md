# Demo: a deck with images generated in-flight

The phase 1 driving use case, executed for real on 2026-08-27: an MCP client
built a four-slide PowerPoint and called `generate_image` for every picture in
it while building. This documents the run so it can be repeated.

## What happened

1. **Four images were generated through the server** — a title illustration, an
   architecture diagram with legible labels (`use_case: text_in_image`), a
   photoreal desk shot, and the lighthouse smoke-test image. Each call returned
   a file path, a cost, and a `selection_reason`; no base64 ever entered the
   client transcript (verified by inspecting the full JSON-RPC output).
2. **The deck was assembled with `pptxgenjs`**, placing the returned paths
   directly into slides — the "tool writes file, returns path, client places
   file" loop from PLAN.md §1.
3. **The cost ledger recorded every generation**: 4 billed images, $0.76 total
   at $0.19 each (curated estimate for `gpt-image-2`; Azure reports no cost in
   its responses).

The provider was **Azure OpenAI** (`gpt-image-2`, deployment in Sweden Central,
GlobalStandard) — configured in `~/.imagine/config.json` with `auth: "api_key"`
and a `deployments` mapping, per the README.

## Repeating it

With any working provider configured:

```
tools/call generate_image {
  "prompt": "...",
  "use_case": "illustration" | "text_in_image" | "photoreal" | ...,
  "output_dir": "<where the deck build wants them>"
}
```

then place `result.path` into the deck with `python-pptx` or `pptxgenjs`. In
practice you simply ask a Claude with both this MCP server and file access to
"build a deck about X and generate the images yourself".

## Findings from the first real run

- **Text-in-image is real**: the prompt asked for the word IMAGINE on the
  lighthouse and for labeled boxes in the diagram; both came back
  letter-perfect, which is exactly why the router scores `gpt-image-2` highest
  for `text_in_image`.
- **Azure quota bit immediately**: a `GlobalStandard` deployment at capacity 1
  rate-limits back-to-back generations; the second call in a burst got 429.
  Raised to capacity 2 (the subscription's quota ceiling) and spaced calls.
- **A router gap surfaced and became [#49](https://github.com/hoeloe15/imagine/issues/49)**:
  `auth_failed` on one provider currently stops routing instead of trying the
  next configured provider, so an invalid OpenRouter key blocked a working
  Azure until the call carried `provider_hint: "azure"`.

## Still open for the issue's "done when"

Issue #14 requires the run to work **with only an OpenRouter key configured**.
That run is pending a valid `OPENROUTER_API_KEY`; everything else — the flow,
the deck, the cost log, the no-base64 check — is demonstrated above.
