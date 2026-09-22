# 29. The picture comes back in the tool result

**Status:** accepted
**Date:** 2026-09-22
**Amends:** [ADR 0024](0024-output-sinks-and-renderable-urls.md) (its starting
premise, not its sinks or links), and PLAN.md §4.2

## Context

The owner's requirement is simple: when you ask for a picture in a chat, the
picture appears in the chat.

It did not. With the hosted server in claude.ai, `generate_image` worked,
stored the image and handed back a link — and the chat showed a grey box saying
"Show Image" that the user had to click before anything appeared. claude.ai
treats pictures from outside addresses as click-to-load, for privacy reasons,
and our link is exactly that. No wording in the result can change how the
client treats an outside link.

ADR 0024 started from a rule we had set ourselves early on: the image itself
never travels back through the tool result, because "a base64 payload in a tool
result is a model's whole context spent on pixels it cannot look at". That
sentence was wrong, and it is worth saying exactly how.

It is true for **text**. Paste the encoded image into a text reply and the
model reads it as a very long string of letters: hundreds of thousands of
tokens of gibberish. That is what PLAN.md §4.2 was guarding against, and that
danger is real.

It is not true for an **image item**. MCP has a separate kind of content for
pictures (`type: "image"`). A client that supports it — claude.ai, Claude Code,
Claude Desktop, Mistral's Le Chat — shows it in the conversation as a picture,
and hands it to the model as a picture it can actually look at. It then costs
what any image costs a vision model: roughly width × height ÷ 750 tokens, so
about 1,400 tokens for a 1024 × 1024 image. Not a context window; a paragraph.

We designed around what we assumed the client would do with the bytes instead
of checking what it actually does with each kind of content.

## Decision

### The picture comes back as an image item, next to the link

A successful `generate_image` now answers with, in this order:

1. **The JSON envelope**, exactly as before. It stays first and stays
   untouched, because clients and tests read it.
2. **The picture**, as `{ type: "image", data: <base64>, mimeType }`. This is
   what makes the chat show it straight away.
3. **A short instruction to the model.** When the picture is included it says
   so, and tells the model *not* to also write it as a markdown image, so the
   user does not see it twice. It may still mention the link and how long the
   link works.
4. **The `resource_link`**, when there is a link, as before.

The encoded picture appears only in the image item. The envelope, the
instruction and `structuredContent` still never contain it, and a test checks
that.

This applies on a laptop too. Claude Code and Claude Desktop show image items
in the conversation, so a local user now sees the picture as well as getting
the file path.

### The link stays

ADR 0024's sinks and links are unchanged and still needed:

- the link is the **full-size** file, and the one a person can share;
- a client that cannot show image items has nothing else;
- a picture too large to send inline (below) still has to reach the user.

### A size limit, with room to spare

Claude refuses a single image larger than 5 MB. It is not clear from the
outside whether that limit counts the raw file or the encoded text, which is
about a third larger. So we measure the **encoded** size, which is what
actually travels, and stop at **4 MB** of it (about 3 MB of raw image). Under
either reading, that stays under Claude's limit.

A typical 1024 × 1024 image is well within that. A picture over the limit is
left out of the result; the link (or, locally, the file path) is kept, and the
instruction tells the model the full-size image is too large for the chat to
show inline and to point the user at the link instead.

We do not shrink or re-compress the image to make it fit. That would mean an
image library and a second, lower-quality copy of every picture; the link
already covers the rare large case.

### A switch to turn it off

`output.inline_image` (default `true`), or the environment variable
`IMAGINE_OUTPUT_INLINE_IMAGE=false`, returns to the link-only result of ADR
0024. That is for a client that handles image items badly, or an operator who
would rather not send pixels to the model at all.

The environment variable joins the `IMAGINE_OUTPUT_*` family and follows the
same order: above config files, below `IMAGINE_CONFIG_JSON`. This stretches ADR
0024's reason for that family a little. Those variables existed because their
values are *created by the deployment*; this one is a plain choice a person
makes. We accept the stretch because it keeps all output settings in one
place, and a single on/off setting is easier to set in a hosting dashboard than
a JSON fragment.

## Consequences

- The user sees the picture in the chat without clicking, in every client that
  supports image items.
- Each generated picture now costs the conversation about 1,400 tokens (more for
  larger sizes). That is the price of the model being able to see what it made,
  which also lets it describe the image, or notice that it is wrong.
- A client that does not support image items shows nothing extra, but the model
  may tell the user the picture is visible when it is not. The link is still in
  the result for that case, and the switch turns the image item off.
- The tool description, `docs/tools.md` and the README no longer promise that
  the image never comes back.
- PLAN.md §4.2's rule is narrowed rather than dropped: base64 still never goes
  into **text**; it only travels as an image item.

## For those who want the detail

- The check is `4 * ceil(bytes / 3) <= 4 * 1024 * 1024`: the base64 length is
  computed from the byte count, without encoding first.
- The bytes are the ones the provider returned (`NormalisedResult.bytes`), passed
  from `generateImage` into `succeeded()`. Nothing is read back from disk or
  from the blob store, and `core/output.ts` is unchanged.
- The ~1,400 tokens is Anthropic's published estimate for image input
  (width × height ÷ 750); other vision models count differently but in the same
  range.
