# MediaScribe

Cloud transcription tool for video/audio files and YouTube URLs. Auto-routes by duration: files under 30 minutes go to OpenRouter (Gemini), longer files go to AssemblyAI.

## Features

- **Local files or YouTube URLs** — pass a file path, folder, or YouTube link
- **Auto-routing** — short files (<30m) use OpenRouter/Gemini, long files (>=30m) use AssemblyAI
- **Library + CLI** — use as an npm package or standalone command
- **Batch processing** — transcribe entire folders recursively with concurrency control
- **Dry run** — estimate cost before transcribing
- **Skip already transcribed** — safe to re-run on a folder

## Requirements

- **Node.js 20+**
- **ffmpeg** / **ffprobe** — for audio processing
- **yt-dlp** — for YouTube URL support

## Setup

```bash
git clone <repo>
cd mediascribe-ts
npm install
npm run build

# Set API keys in .env
echo 'OPENROUTER_API_KEY=sk-or-v1-...' >> .env
echo 'ASSEMBLYAI_API_KEY=...' >> .env

# Make globally available
npm link
```

## CLI Usage

```bash
# Single file
mediascribe video.mp4

# YouTube URL
mediascribe "https://youtube.com/watch?v=..."

# Folder (recursive)
mediascribe ./lectures/

# Estimate cost
mediascribe ./lectures/ --dry

# Transcribe folder, then join transcripts into "Raw - *.md" + PDF (via jjoin)
mediascribe ./lectures/ --jjoin

# Options
mediascribe video.mp4 -o notes.md --timestamps
mediascribe ./lectures/ --concurrency 5
mediascribe video.mp4 --model google/gemini-2.5-flash
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `input` | Path to file/folder or YouTube URL | *(required)* |
| `-o, --output` | Output markdown file (ignored for folders) | `<input>.md` |
| `--timestamps` | Include timestamps in output | off |
| `--model` | OpenRouter model (for files <30m) | `google/gemini-3-flash-preview` |
| `--concurrency` | Parallel transcription jobs | `3` |
| `--dry` | Estimate cost without transcribing | off |
| `--force-ass` | Force AssemblyAI for all files regardless of duration | off |
| `--jjoin` | After transcribing a folder, run `jjoin` (md-join.sh) on every folder containing transcripts — produces `Raw - <prefix>.md` per folder (no PDF; `mediascribe` sets `JJOIN_NO_PDF=1`). Skipped if any file failed (rerun to finish). Folder input only. | off |
| `--summary` | After transcribing and joining, summarize each joined `Raw - *.md` into `Summary - <name>.md` beside it (via `anthropic/claude-opus-4.8`, the same engine as the `summary` command). Implies `--jjoin`. Folder input only. | off |
| `--no-copy` | Do not copy the result file path(s) to the clipboard. By default, after `--jjoin`/`--summary` the final result path(s) — the `Summary - *.md` when summarizing, otherwise the `Raw - *.md` — are copied to the Wayland clipboard (via `wl-copy`), each quoted and newline-separated. | (copy on) |

```bash
# Transcribe a course folder, join per subfolder, and summarize each joined file
mediascribe ./course/ --summary
```

## `summary` command

A second binary, `summary`, turns a **PDF or Markdown/text file** into a nicely formatted
Markdown конспект (detailed summary, in Russian) via OpenRouter. It shares this project's
`.env` (`OPENROUTER_API_KEY`) and build.

Requires **`pdftotext`** (poppler / poppler-utils) for PDF input; `.md`/`.txt` are read directly.

```bash
# Default: Opus 4.8, writes "Summary - <name>.md" next to the input
summary lecture.pdf
summary "Raw - Course.md"

# Cheaper model
summary notes.md --model google/gemini-3-flash-preview

# Estimate size/cost without calling the API
summary book.pdf --dry

# Override prompts (literal text, or @path to read from a file)
summary notes.md --prompt "@/path/to/prompt.txt" --system "@/path/to/system.txt"
```

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output` | Output markdown file | `Summary - <name>.md` next to input |
| `--model` | OpenRouter model slug | `anthropic/claude-opus-4.8` |
| `--max-tokens` | Max output tokens | `8000` |
| `--system` | Override system prompt (literal text or `@file`) | faithful-summarizer default |
| `--prompt` | Override summary prompt (literal text or `@file`) | detailed-конспект default |
| `--dry` | Show extracted size + cost estimate, no API call | off |

Inputs above ~700K tokens (e.g. large merged `Raw - *.md`) are summarized via **map-reduce**
(chunk → summarize each → synthesize one конспект) automatically; smaller inputs go in a single
pass. Existing output files are not overwritten unless `-o` is given.

## Library Usage

```typescript
import { transcribe, estimateCost, isYouTubeUrl } from 'mediascribe'

// Transcribe a local file
const result = await transcribe('./video.mp4')
console.log(result.markdown)     // formatted markdown string
console.log(result.paragraphs)   // [{ text, timestamp }]
console.log(result.backend)      // 'openrouter' | 'assemblyai'
console.log(result.duration)     // seconds

// Transcribe a YouTube URL
const result = await transcribe('https://youtube.com/watch?v=...')

// Estimate cost
const est = await estimateCost('./video.mp4')
console.log(est.backend, est.cost)

// Pass API keys explicitly
const result = await transcribe('./video.mp4', {
  openrouterApiKey: '...',
  assemblyaiApiKey: '...',
  timestamps: true,
})
```

## How It Works

```
Input → detect type
  ├── YouTube URL → yt-dlp (download audio) ─┐
  ├── Local file ─────────────────────────────┤
  └── Folder → collect files → concurrent ────┘
                                              ↓
                                    ffprobe (get duration)
                                              ↓
                              ┌─── < 30 minutes ──┴── >= 30 minutes ───┐
                              ↓                                 ↓
                     OpenRouter/Gemini                    AssemblyAI
                  (compress → base64 → API)           (upload → poll)
                              ↓                                 ↓
                              └────────── Markdown ────────────┘
```

## File Structure

```
src/
├── index.ts              # Public API exports
├── cli.ts                # CLI (commander)
├── transcribe.ts         # Routing + orchestration
├── backends/
│   ├── openrouter.ts     # OpenRouter/Gemini (<30m)
│   └── assemblyai.ts     # AssemblyAI (>=30m)
├── audio.ts              # ffprobe/ffmpeg utilities
├── markdown.ts           # Markdown formatting
├── youtube.ts            # yt-dlp integration
└── types.ts              # Types + constants
```

## License

MIT
