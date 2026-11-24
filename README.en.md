[简体中文](README.md) · [English](README.en.md)

<p align="center">
  <img src="build/icon.png" width="88" height="88" alt="EchoQ Ops" />
</p>

<h1 align="center">EchoQ Ops</h1>

<p align="center">Research, write, illustrate, preview, publish, and review — in one pipeline.</p>

> A Windows content operations workbench that runs locally (Next edition, currently 0.2.5). From topic to publish and back to review, everything happens in one window. It runs as a single process and listens on `127.0.0.1:8711` by default; accounts and the copy/image relay are provided by EchoQ. Intended for content creation and operations efficiency; make sure your use complies with each platform's rules and local laws.

![Operations dashboard](docs/ui/dashboard.png)

## Features

### Operations dashboard: what needs doing today, at a glance

The home page summarizes today's published, pending, and queued notes plus unused topics, with account status and usage on the right. Expired logins, failed jobs, and a backlog all surface here — one click takes you to the page that fixes them.

### Topic pool: from keywords to writable topics

Mine topics by keyword, competitor account, channel, or on-site hot list, score and sort them, then turn the pick into a draft. Bulk import, pick from the question bank, or add one manually.

![Topic pool](docs/ui/topics.png)

### Studio: write once, publish to several platforms

Pick the platform (Xiaohongshu / Douyin / WeChat Official Accounts), publishing account, and visibility on one page. The body switches between plain text and Markdown; WeChat drafts can apply multiple layout themes. The phone preview on the right updates as you type, mirroring title, body, hashtags, and images in the platform's own style. A built-in local model drafts from a brief, with selectable tone — and it keeps your writing habits.

![Studio](docs/ui/studio.png)

### Illustrations 2.0: style × layout × palette

6 practical feed styles × 4 layouts × 3 palettes — 24 combinations, all rendered locally with HTML / CSS. Style cards carry sample previews so you can see the result before choosing; one request can produce 3 candidates with distinct styles and layouts, laid out side by side in the media preview area, and "Use" commits one as the official image. An appearance ledger records the styles used per account, down-weights recent ones, and forces a different style after two in a row, so consecutive posts do not look identical.

### Hand-drawn illustrations: 5 media, reproducible by seed

Flat vector, pencil wash, marker comic, sumi-e ink, and paper-cut festival — randomness comes only from a seed: the same draft and composition render pixel-identically every time, and "Another composition" re-renders with a new seed. Supports 3:4 portrait (cover / content / closing pages) and 2.35:1 wide format for WeChat.

![Hand-drawn illustration](docs/ui/sketch.png)

### Motion images: GIF and MP4

Animated images render frame by frame (6s × 25fps), then ffmpeg composites `loop.gif` and `motion.mp4`. If frame rendering or compositing fails, it falls back to the static first frame and records the reason on the job, so publishing never hangs.

### Publishing: queue, account rotation, and limits

Jobs run idempotently from a queue, with account rotation, daily limits and minimum intervals, failure classification with backoff, scheduled publishing, and one draft to multiple accounts. Expired logins are flagged and swapped automatically instead of stalling the queue.

### Review: published records and scheduled sync

Published notes are cached locally and can sync engagement data on a schedule. Failure details, retry counts, and reasons stay on each job, and scheduled task run history is visible on the page.

### Accounts: QR or cookie sign-in

Sign in by QR code or import cookies; credentials are encrypted locally. Account health is checked periodically, with automatic cooldown on risk control and a gradual ramp-up after recovery.

## Typical use

| Scenario | How |
| --- | --- |
| Daily topic selection and drafting | Mine topics in the topic pool, draft from a brief in the studio |
| Check the layout before publishing | Phone preview on the right, updated while you edit |
| Need illustrations | Pick built-in templates by sample preview; re-roll hand-drawn compositions |
| Multiple accounts | Publish queue + account rotation + daily limits |
| Scheduled publishing | Scheduled tasks enqueue jobs at the chosen time |
| Review performance | Published records cached locally, engagement synced on a schedule |

## Quick start

1. **Download**: get the installer or portable build from [Releases](https://github.com/xhmooc/echoq-ops/releases). Windows 10 / 11 (x64)
2. **Sign in**: launch the app and sign in with your EchoQ account; drafts, images, and publish records stay on your machine
3. **Start**: pick a platform and topic, then go write → illustrate → preview → publish

Run from source (Node.js 20+):

```powershell
cd desktop
npm install
npm run dev
```

## More

- **Compliance checks**: sensitive-word and platform-rule warnings while generating
- **Layout checks**: bounds, overlap, tiny type, and poor whitespace are checked before rendering — blocking what must be blocked, warning on the rest
- **Visible failures**: failed jobs retry with backoff, and the reason stays on the job
- **Recoverable interruptions**: unfinished jobs are re-queued after a crash or exit instead of being dropped
- **Local storage**: credentials, drafts, images, and publish records stay on your machine

## Roadmap

**Hand-drawn illustrations**: more media (marker / highlighter, risograph, ink wash, woodcut, crayon and colored pencil), each with its own "mark-making" parameters rather than a palette swap; expand the subject library from 10 to 24, add two-subject relationships and three composition templates; handwritten titles that match each medium's stroke; later, bind style packs to accounts, keep a reusable illustration history, and illustrate sections by semantics.

**WeChat layout**: figure captions, quote cards, callout cards, tables of contents, step bars, and pull-quote blocks; inline code highlighting; a style-convergence check before pasting into WeChat; layout presets bound to accounts.

**Content and platform model**: a multi-platform version view of one draft (Xiaohongshu copy / WeChat long-form, convertible both ways), and a central platform capability matrix for title length, image count, and rich-text support.

## Troubleshooting

First check the installer version and system architecture (Windows x64). If that does not help, [open an issue](https://github.com/xhmooc/echoq-ops/issues/new) with the version, Windows version, and the exact error text — mask any account details in screenshots.

You can also join the feedback group: EchoQ Ops Group 1, **1136843749**.

## Build

```powershell
cd desktop
npm install
npm run dist
```

Output goes to `release\desktop\`.

## Project layout

```text
EchoQ-Ops/
├─ desktop/             current desktop app (Electron + Node, port 8711)
├─ ops/                 legacy aiohttp backend and web frontend
├─ vendor/              upstream Spider_XHS code: apis / xhs_utils / spider / upstream
├─ docs/                architecture, API, data model, runbook, changelog, and roadmap
├─ electron/            legacy desktop shell
├─ website/             marketing site source
└─ run.cmd              legacy entry point
```

More docs: [Architecture](docs/ARCHITECTURE.md) · [Runbook](docs/RUNBOOK.md) · [API](docs/API.md) · [Data model](docs/DATA_MODEL.md) · [Changelog](docs/CHANGELOG.md) · [Roadmap](docs/ROADMAP.md)

## License

[MIT](LICENSE). Product names, logos, and the EchoQ cloud services are not covered by this license.

`vendor/` comes from [cv-cat/Spider_XHS](https://github.com/cv-cat/Spider_XHS) under the MIT license; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
