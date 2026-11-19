# mo3ta-coverage — Video Production Plan

Status: **in progress** · Owner: next agent · Last updated: 2026-11-19

Goal: produce two local MP4 promo videos for `mo3ta-coverage` using the
OpenMontage / HyperFrames skill:

1. **5s teaser** — first deliverable.
2. **15s explainer** — full story, built only after the 5s cut is approved.

No API keys, TTS, stock footage, or music are required. Everything is authored
as HTML/CSS/GSAP and rendered locally with HyperFrames + FFmpeg.

---

## 1. Inputs and environment

| Item | Value |
| --- | --- |
| Video skill / vendor | `/Users/appleworld/Documents/Diff/vendor/OpenMontage` |
| HyperFrames guide | `OpenMontage/skills/core/hyperframes.md` |
| Authoring contract | `OpenMontage/.agents/skills/hyperframes-core/SKILL.md` |
| Reference composition | `OpenMontage/projects/json-change-explainer/hyperframes/index.html` |
| Cached HyperFrames CLI | `/Users/appleworld/.npm/_npx/702923228c2ce1e6/node_modules/.bin/hyperframes` (v0.9.23) |
| Fallback CLI | `npx --yes hyperframes@0.9.23` |
| Node | v24.14.1 |
| FFmpeg / FFprobe | 8.1.1 (`/opt/homebrew/bin`) |
| Chrome headless | cached at `~/.cache/hyperframes/chrome` |

Do **not** use `npx @hyperframes/cli` (404). The public package is `hyperframes`.

Convenience for every command below:

```bash
export HF=/Users/appleworld/.npm/_npx/702923228c2ce1e6/node_modules/.bin/hyperframes
export REPO=/Users/appleworld/Documents/mo3ta-coverage
```

---

## 2. Deliverables

```text
/Users/appleworld/Documents/mo3ta-coverage/
├── VIDEO_PLAN.md                          <- this file
└── video/
    ├── .gitignore                         <- ignores .hyperframes/ and renders/
    ├── mo3ta-coverage-5s/
    │   ├── index.html                     <- HyperFrames composition
    │   ├── gsap.min.js                    <- local GSAP (offline render)
    │   └── hyperframes.json
    ├── mo3ta-coverage-15s/
    │   ├── index.html
    │   ├── gsap.min.js
    │   └── hyperframes.json
    └── renders/
        ├── mo3ta-coverage-5s.mp4
        └── mo3ta-coverage-15s.mp4
```

Output spec: **1920×1080, 30 fps, H.264 MP4, no audio track**.

If `video/` is committed later, add `/video/renders/` (or all of `/video/`) to
`.npmignore` so MP4s are not published to npm.

---

## 3. Product story

`mo3ta-coverage` runs only the tests related to the lines changed in a PR, then
checks coverage for those changed lines.

Key message:

> **Changed code. Related specs. Real coverage.**

Supporting points:

- Finds changed JS/TS files against a base branch.
- `smart` mode finds related spec files even when names differ.
- Uses a depth-limited reverse-import graph (`--depth 1` or `2`) to catch
  barrel/re-export layers without running the whole suite.
- Reports uncovered changed lines and fails below a coverage limit.
- Works locally and in CI.

Example command to show on screen:

```bash
npx mo3ta-coverage --mode smart --base origin/main --limit 80
```

---

## 4. Creative direction

**Look:** dark developer tool, editorial motion graphics, no people, no stock
footage. Crisp mono labels, syntax-colored diff lines, subtle grid and glow.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0F1115` | canvas |
| `--card` | `#1A1C22` | terminal / report panels |
| `--border` | `#2A2D35` | panel borders |
| `--text` | `#E6E6E6` | body |
| `--bright` | `#F4F7FB` | headlines |
| `--muted` | `#9AA0A6` | secondary copy |
| `--accent` | `#60A5FA` | brand / CTA |
| `--pass` | `#22C55E` | covered lines, pass |
| `--fail` | `#F87171` | uncovered lines |
| `--warn` | `#FB923C` | attention |

Fonts: **Inter** for UI/headlines, **JetBrains Mono** for code. Both are
supported by the HyperFrames deterministic font compiler.

Motion: 0.4–0.8s power2/power3 eases, 18–42px rise, small staggers. No infinite
loops, no unseeded randomness, no clocks.

---

## 5. Storyboard — 5s teaser

Duration: **5.0s**. One continuous dark stage.

| Time | Scene | Content | Motion |
| --- | --- | --- | --- |
| 0.0–1.2 | Hook | Pill `PR COVERAGE · SMART MODE` + wordmark `mo3ta-coverage` + line `Changed code. Related specs.` | fade-up cascade |
| 1.2–2.6 | Command | Terminal card, types `npx mo3ta-coverage --mode smart` then `--base origin/main` | caret blink via finite steps, prompt glow |
| 2.6–3.9 | Smart graph | Left: `src/utils/helper.js` changed. Right: `specs/custom-name.spec.js`. Arrow/label `related spec · depth 1` | nodes pop, link draws, label fades |
| 3.9–5.0 | Result | Report card: `100% changed-line coverage`, green check, `limit 80%` | count-up, check draws, hold |

Copy:

- `Changed code. Related specs.`
- `Even when the test name doesn't match.`
- `100% changed-line coverage`

---

## 6. Storyboard — 15s explainer

Duration: **15.0s**.

| Time | Scene | Content | Motion |
| --- | --- | --- | --- |
| 0.0–2.0 | Hook | Pill, wordmark, `Changed code. Related specs. Real coverage.` | title cascade |
| 2.0–4.8 | Problem | Mini PR diff: 3 changed lines. Text `Running the whole suite is slow.` | diff rows slide in, muted clock motif |
| 4.8–8.0 | Smart mode | Command types; graph builds: changed file → barrel → differently named spec, labels `depth 1` / `depth 2` | graph nodes + link draw, depth badges pulse once |
| 8.0–11.0 | Coverage | Jest result panel: `PASS specs/custom-name.spec.js`, coverage table, changed lines turn green/red | rows cascade, line markers pop |
| 11.0–13.0 | Verdict | `Overall changed-line coverage 100%` vs `limit 80%`, `Not covered: 0 of 3` | counter + progress bar fill |
| 13.0–15.0 | CTA | End card: wordmark, `Changed code. Related specs. Real coverage.`, command pill | fade-up, hold |

Narrative copy:

1. `Every PR changes a few lines.`
2. `But CI runs the whole suite.`
3. `mo3ta-coverage starts from changed files.`
4. `Smart mode walks imports to depth 1 or 2.`
5. `It finds the right spec — even with a different name.`
6. `Then checks coverage for changed lines only.`
7. `Fail the build only when the diff is under-covered.`

---

## 7. HyperFrames authoring rules

- Root is a standalone `<div data-composition-id="..." data-width="1920"
  data-height="1080" data-start="0" data-duration="5">` (or `15`).
- Add `data-fps="30"` on the root if supported; otherwise pass `-f 30` at render.
- Scene wrappers use `class="clip"` with `data-start`, `data-duration`,
  `data-track-index`.
- Register exactly one timeline synchronously:
  `window.__timelines["<composition-id>"] = gsap.timeline({ paused: true })`.
- Animate only transform/opacity/color/filter/clip-path properties.
- No `repeat: -1`; use finite repeats for caret blink.
- Put the full-bleed background on a child `position:absolute; inset:0`, not on
  the root element.
- Keep all IDs unique.
- No `<br>` inside paragraph copy.

Minimal root shape:

```html
<div id="root" data-composition-id="mo3ta-5s"
     data-width="1920" data-height="1080"
     data-start="0" data-duration="5" data-fps="30">
  <div class="stage clip" data-start="0" data-duration="5" data-track-index="0">
    <!-- scenes -->
  </div>
</div>
```

---

## 8. Build and verification commands

Run from the workspace directory:

```bash
cd "$REPO/video/mo3ta-coverage-5s"
$HF lint .
$HF check . --at 0.5,1.5,3.0,4.5 --no-contrast
$HF snapshot . --at 0.5,1.5,3.0,4.5
$HF render . -o "$REPO/video/renders/mo3ta-coverage-5s.mp4" -q standard -f 30
```

Repeat for `mo3ta-coverage-15s` with sample times `1,3,6,9,12,14.5`.

Verify every render:

```bash
ffprobe -v error \
  -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 \
  "$REPO/video/renders/mo3ta-coverage-5s.mp4"
```

Acceptance:

- 5s file duration `5.0 ± 0.05s`.
- 15s file duration `15.0 ± 0.05s`.
- 1920×1080, ~30 fps, `h264`, sensible file size.
- `lint` has 0 errors. `check` has no errors (contrast may be deferred during
  iteration, but should be re-run before calling the cut final).
- Keyframe snapshots readable at 100% zoom: no clipped text, no overlapping
  cards, no black frames.
- CTA command is legible and correctly spelled.

---

## 9. Checklist

### Discovery
- [x] Locate the OpenMontage vendor/skill.
- [x] Read HyperFrames core contract and OpenMontage HyperFrames guide.
- [x] Verify Node 24, FFmpeg 8.1.1, cached Chrome, cached HyperFrames CLI.
- [x] Pick 16:9 / 1080p / 30 fps / no-audio delivery.
- [x] Lock the storyboard, copy, and visual tokens above.

### 5s teaser
- [x] Create `video/mo3ta-coverage-5s/` + `hyperframes.json`.
- [x] Author `index.html` (hook → command → smart graph → result).
- [x] `lint` passes with 0 errors.
- [x] `check` / snapshots reviewed at 0.5s, 1.5s, 3.0s, 4.5s.
- [x] Render `video/renders/mo3ta-coverage-5s.mp4`.
- [x] Verify duration / resolution / fps with `ffprobe`.
- [x] Share the 5s cut for approval before starting the 15s.

### 15s explainer
- [x] Create `video/mo3ta-coverage-15s/` + `hyperframes.json`.
- [x] Author `index.html` (hook → problem → smart graph → coverage → verdict → CTA).
- [x] `lint` passes with 0 errors.
- [x] `check` / snapshots reviewed across all six beats.
- [x] Render `video/renders/mo3ta-coverage-15s.mp4`.
- [x] Verify duration / resolution / fps with `ffprobe`.

### Wrap-up
- [x] Add `/video/renders/` to `.gitignore`; add `/video` to `.npmignore`.
- [ ] Link both MP4s from `README.md` (optional).
- [ ] Commit the plan and workspaces (renders stay local).
- [x] Share final paths with the user.

---

## 10. Handoff notes

### Status (2026-11-19)

Both cuts are **rendered and verified**:

| Output | Duration | Resolution | FPS | Codec | Size |
| --- | --- | --- | --- | --- | --- |
| `video/renders/mo3ta-coverage-5s.mp4` | 5.000s | 1920×1080 | 30 | h264 | 578 KB |
| `video/renders/mo3ta-coverage-15s.mp4` | 15.000s | 1920×1080 | 30 | h264 | 1.1 MB |

`lint` → 0 errors on both. `check` → 0 errors on both; remaining items are
advisory warnings only (`nested_structure_needs_subcomposition` for the single
`#stage` clip, small-UI-type floor, and `line_unread` on transitional captions).
No blocking errors.

Implementation details worth knowing:

- Both workspaces load a local `gsap.min.js` (copied beside `index.html`), so
  rendering works offline. Fonts still come from the Google Fonts `@import`
  and are cached in `~/.cache/hyperframes/fonts`.
- `hyperframes check` flagged an over-short final hold on the 15s end card, so
  the end card was pulled forward and the CTA command shortened to
  `npx mo3ta-coverage --mode smart`. The full command with `--base origin/main`
  still appears in the 5s teaser's typing beat.
- Frame 0 was intentionally made non-empty in both cuts by keeping the hook
  visible and animating only transforms (no initial opacity 0 on `#hook`).
- Snapshot contact sheets live under each workspace's
  `.hyperframes/artifacts/snapshots/` (git-ignored along with the rest of
  `.hyperframes/`).
- `video/renders/` is git-ignored; `/video` is npm-ignored so MP4s and
  workspaces never ship in the published package.

### Optional next steps

- Add a short README section linking the MP4s.
- Commit `VIDEO_PLAN.md` and both `video/mo3ta-coverage-*/` workspaces
  (leave `video/renders/` local).
- If a voiceover or music bed is wanted later, add it in HyperFrames/FFmpeg;
  current cuts are intentionally silent and caption-free so they loop cleanly
  in a README or social post.

### Product references

- Source of truth for the product behavior is `src/fileUtils.js` and
  `src/cli.js`; smart mode = naming matches + reverse-import walk to
  `--depth` (default 2).
- The 5s piece stands alone without narration.
- If the cached CLI is missing on another machine, use
  `npx --yes hyperframes@0.9.23`; `doctor` must pass Node/FFmpeg/Chrome before
  rendering.
- Do not switch to Remotion or FFmpeg silently. If HyperFrames fails, report the
  blocker and get approval before downgrading runtime.
