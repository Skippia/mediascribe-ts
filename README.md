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
