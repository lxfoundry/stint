# Stint brand

The mark is a split capsule between square brackets:

- **The brackets** are the session's bounds: from when it opens to the longest it can run.
- **The solid part** is the time used, which the seller is paid for.
- **The outlined part** is the time left, which returns to the payer when the session closes.

## Files

| File | Use |
|---|---|
| `stint-mark.svg` | The mark, on light backgrounds |
| `stint-mark-dark.svg` | The mark, on dark backgrounds |
| `stint-lockup.svg` | Mark and wordmark, on light backgrounds |
| `stint-lockup-dark.svg` | Mark and wordmark, on dark backgrounds |
| `stint-icon.svg`, `icon-512.png`, `icon-192.png` | App icon: avatars, web app manifests |
| `apple-touch-icon.png` | 180 px home-screen icon |
| `favicon.svg`, `favicon.ico` (16, 32 and 48 px), `favicon-16.png`, `favicon-32.png` | Browser tabs |
| `readme-header.svg`, `readme-header-dark.svg` | This repository's README header |

The SVGs need no fonts: the text in them is drawn as outlines.

## Rules

- **Use the brackets from 24 px wide upwards.** Below that, use the plain two-tone capsule of the
  favicon: at that size the brackets blur into noise.
- **Two states only:** solid for time used, outline for time left.
- **In interfaces, show progress with the plain capsule.** The card or line around it already marks
  the bounds. The states are:
  - **Opened**
  - **Running**
  - **Closed early:** the returned part is highlighted in Signal.
  - **Expired:** a fully solid capsule.
- **In a lockup:**
  - the brackets span the wordmark's x-height, from the baseline up;
  - the gap between mark and wordmark is 0.3 × the type size.
- **Clear space:** at least half the mark's height on every side.
- **Don't** add gradients, shadows or extra outlines, rotate the mark, fill the outlined part, or
  use colours outside the palette.

## Colours

| Name | Hex | Use |
|---|---|---|
| Ink | `#111318` | Mark and text on light backgrounds; dark backgrounds |
| Paper | `#F4F5F2` | Light backgrounds; mark lines and text on dark backgrounds |
| Signal | `#2ED18B` | The used part on dark backgrounds; highlights. Never text on light backgrounds |
| Deep | `#0B6B45` | Accent text on light backgrounds |
| Slate | `#5E636C` | Secondary text on light backgrounds |
| Mist | `#A9AEB6` | Secondary text on dark backgrounds |

## Type

- **Space Grotesk:**
  - weight 600 for the wordmark, tracked −3.3 %;
  - weight 500 for headings and taglines.
- **JetBrains Mono:** code, CLI output and figures.

Both are licensed under the SIL Open Font License 1.1. Space Grotesk: copyright 2020 The Space
Grotesk Project Authors. JetBrains Mono: copyright 2020 The JetBrains Mono Project Authors.
