# MediaScribe

Cloud transcription tool for video/audio files, YouTube videos, and YouTube playlists. Transcription always runs through AssemblyAI. By default YouTube/playlist/link inputs are fetched as audio, transcribed, and discarded — only the transcript remains. Pass `--keep` to download and preserve the full `.mp4`, and an optional trailing folder to choose where output lands.

## Features

- **Local files, YouTube videos & playlists** — pass a file path, folder, YouTube video link, or playlist link
- **Transient by default** — YouTube/playlist/link media is fetched as audio-only, transcribed, then deleted; only the transcript is left. Pass `--keep` to download the full video (`.mp4`) and preserve it.
- **Link-list files** — pass a `.md`/`.txt` containing YouTube links; every link is transcribed (videos as files, playlists as subfolders)
- **Destination folder** — an optional trailing folder path sets where media/transcripts go (default: current dir, or an auto-named folder for a playlist / link-list)
- **AssemblyAI transcription** — all transcription runs through AssemblyAI (`ASSEMBLYAI_API_KEY`)
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
echo 'ASSEMBLYAI_API_KEY=...' >> .env            # required (transcription)
echo 'OPENROUTER_API_KEY=sk-or-v1-...' >> .env   # only for the `summary` command / --summary

# Make globally available
npm link
```

## CLI Usage

Run `mediascribe --help` (or just `mediascribe`) for a one-screen overview of both commands (`mediascribe` + `summary`), their flags, and pipelines.

```bash
# Single file
mediascribe video.mp4

# YouTube video — transcribe only (audio fetched, transcribed, then deleted)
mediascribe "https://youtube.com/watch?v=..."

# Keep the downloaded video too ("<title>.mp4" + "<title>.md" in the current dir)
mediascribe --keep "https://youtube.com/watch?v=..."

# Send output to a specific folder (trailing path; works with or without --keep)
mediascribe --keep "https://youtube.com/watch?v=..." ~/videos/talks

# YouTube playlist — transcribe every video; --dry first to see count + cost
mediascribe "https://www.youtube.com/playlist?list=..." --dry
mediascribe --keep "https://www.youtube.com/playlist?list=..." ~/podcasts/series

# Link-list file — extract every YouTube link, transcribe all
mediascribe ./links.md
mediascribe ./links.md --dry                 # count links + estimate cost first
mediascribe --keep ./links.md ~/archive      # keep videos, output into ~/archive

# Folder (recursive)
mediascribe ./lectures/

# Estimate cost
mediascribe ./lectures/ --dry

# Transcribe folder, then join transcripts into "Raw - *.md" + PDF (via jjoin)
mediascribe ./lectures/ --jjoin

# Options
mediascribe video.mp4 -o notes.md --timestamps
mediascribe ./lectures/ --concurrency 5
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `input` | Path to file/folder, YouTube video/playlist URL, or a `.md`/`.txt` of links | *(required)* |
| `dest` | Output folder for media + transcripts (YouTube/link inputs) | current dir / auto-named |
| `-o, --output` | Output markdown file (ignored for folders) | `<input>.md` |
| `--timestamps` | Include timestamps in output | off |
| `--keep` | Keep the downloaded video(s) after transcribing | off (audio-only, deleted) |
| `--concurrency` | Parallel transcription jobs | `3` |
| `--dry` | Estimate cost without transcribing | off |
| `--force-ass` | (deprecated, no-op) AssemblyAI is always used | off |
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
                                       AssemblyAI
                                 (compress → upload → poll)
                                              ↓
                                         Markdown
```

## File Structure

```
src/
├── index.ts              # Public API exports
├── cli.ts                # CLI (commander)
├── transcribe.ts         # Routing + orchestration
├── backends/
│   ├── openrouter.ts     # OpenRouter client (used by the summary command)
│   └── assemblyai.ts     # AssemblyAI (transcription)
├── audio.ts              # ffprobe/ffmpeg utilities
├── markdown.ts           # Markdown formatting
├── youtube.ts            # yt-dlp integration
└── types.ts              # Types + constants
```

## License

MIT
