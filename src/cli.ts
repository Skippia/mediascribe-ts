#!/usr/bin/env node

import { resolve, extname, relative, basename, dirname, join } from 'node:path'
import { writeFile, readFile, readdir, stat, mkdir, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { config } from 'dotenv'
import { Command } from 'commander'
import { transcribe, estimateCost, estimateCostForDuration } from './transcribe.js'
import { summarizeFile, buildSummaryDocument } from './summarize.js'
import { fileExists, copyToClipboard } from './util.js'
import { hasAudioStream } from './audio.js'
import {
  isYouTubeUrl,
  getYouTubeInfo,
  isYouTubePlaylistUrl,
  getPlaylistInfo,
  downloadVideo,
  downloadPlaylist,
  extractYouTubeUrls,
  downloadVideoInto,
  downloadPlaylistInto,
} from './youtube.js'
import { formatTimestamp } from './markdown.js'
import { SUMMARY_DEFAULT_MODEL, SUPPORTED_EXTENSIONS } from './types.js'

// Load .env from script directory
config({ path: new URL('../.env', import.meta.url).pathname })

interface CliOptions {
  output?: string
  timestamps: boolean
  concurrency: number
  dry: boolean
  forceAss: boolean
  jjoin: boolean
  summary: boolean
  copy: boolean
  keep: boolean
  setKey?: string
}

/** Absolute path of the .env that dotenv loads at startup (see config() above). */
const ENV_PATH = new URL('../.env', import.meta.url).pathname

/** Show only the tail of a secret, e.g. "****abcd", so it can be confirmed without leaking. */
function maskKey(key: string): string {
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`
}

/**
 * Persist ASSEMBLYAI_API_KEY into the .env that the CLI reads on startup.
 * Replaces an existing assignment in place (preserving every other line and
 * comment) or appends one if absent. Creates the file if it does not exist.
 */
async function setAssemblyAIKey(rawKey: string): Promise<void> {
  const key = rawKey.trim()
  if (!key) throw new Error('--set-key requires a non-empty value')
  if (/[\r\n]/.test(key)) throw new Error('API key must not contain newlines')

  const line = `ASSEMBLYAI_API_KEY=${key}`
  // Matches `KEY=`, `export KEY=`, with optional surrounding whitespace.
  const assignment = /^\s*(?:export\s+)?ASSEMBLYAI_API_KEY\s*=/

  let existing = ''
  if (await fileExists(ENV_PATH)) {
    existing = await readFile(ENV_PATH, 'utf-8')
  }

  let next: string
  if (existing === '') {
    next = `${line}\n`
  } else {
    const lines = existing.split('\n')
    const idx = lines.findIndex((l) => assignment.test(l))
    if (idx === -1) {
      // Append, guaranteeing the new line starts on its own row.
      const sep = existing.endsWith('\n') ? '' : '\n'
      next = `${existing}${sep}${line}\n`
    } else {
      lines[idx] = line
      next = lines.join('\n')
    }
  }

  await writeFile(ENV_PATH, next, { mode: 0o600 })
  // Reflect the change in this process too, so a chained run picks it up.
  process.env.ASSEMBLYAI_API_KEY = key
  console.log(`✓ Saved ASSEMBLYAI_API_KEY (${maskKey(key)}) to ${ENV_PATH}`)
}

/** Label naming whichever folder-pipeline flags are active, for error/skip messages. */
function pipelineLabel(options: CliOptions): string {
  return [options.jjoin && '--jjoin', options.summary && '--summary'].filter(Boolean).join('/')
}

async function collectFiles(dirPath: string): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(full)
      }
    }
  }

  await walk(dirPath)
  return files.sort()
}

async function filterPendingFiles(files: string[]): Promise<{ pending: string[]; skipped: number }> {
  const pending: string[] = []
  let skipped = 0
  for (const f of files) {
    const mdPath = f.replace(extname(f), '.md')
    if (await fileExists(mdPath)) {
      skipped++
    } else {
      pending.push(f)
    }
  }
  return { pending, skipped }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/*?:"<>|]/g, '').trim().slice(0, 200) || 'transcript'
}

// Print a "known duration + estimated cost" summary for a set of (possibly unknown) durations.
// Shared by the --dry paths of runPlaylist and runLinkFile.
function printDurationCostEstimate(durations: Array<number | null>): void {
  let cost = 0
  let knownDuration = 0
  let unknown = 0
  for (const d of durations) {
    if (d == null) {
      unknown++
      continue
    }
    knownDuration += d
    cost += estimateCostForDuration(d).cost
  }
  console.log(`   Known duration: ${formatTimestamp(knownDuration)} (${(knownDuration / 60).toFixed(1)} min)`)
  if (unknown) console.log(`   ${unknown} item(s) with unknown duration (excluded from estimate)`)
  console.log(`   Estimated cost (AssemblyAI): ~$${cost.toFixed(2)}`)
}

function runJjoin(dir: string): Promise<void> {
  return new Promise((res, rej) => {
    // JJOIN_NO_PDF=1 → md-join.sh produces only the merged .md, no PDF.
    const child = spawn('jjoin', [dir], {
      stdio: 'inherit',
      env: { ...process.env, JJOIN_NO_PDF: '1' },
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      rej(
        err.code === 'ENOENT'
          ? new Error('jjoin not found in PATH (expected ~/.local/bin/jjoin -> md-join.sh)')
          : err,
      )
    })
    child.on('exit', (code) => {
      if (code === 0) res()
      else rej(new Error(`jjoin exited with code ${code} for: ${dir}`))
    })
  })
}

// The "Raw - *.md" file jjoin just wrote in `dir` is the most recently modified one.
async function findNewestRaw(dir: string): Promise<string | null> {
  const entries = await readdir(dir)
  let newest: string | null = null
  let newestMtime = -Infinity
  for (const name of entries) {
    if (!name.startsWith('Raw - ') || !name.endsWith('.md')) continue
    const path = join(dir, name)
    const { mtimeMs } = await stat(path)
    if (mtimeMs > newestMtime) {
      newestMtime = mtimeMs
      newest = path
    }
  }
  return newest
}

// Run jjoin once per directory that holds at least one transcript.
// jjoin itself is non-recursive (maxdepth 1), so nested course folders
// each get their own "Raw - *.md" + PDF. Returns the produced Raw file paths.
async function joinTranscripts(mediaFiles: string[]): Promise<string[]> {
  const dirs = new Set<string>()
  for (const f of mediaFiles) {
    const mdPath = f.replace(extname(f), '.md')
    if (await fileExists(mdPath)) dirs.add(dirname(mdPath))
  }

  if (dirs.size === 0) {
    console.log('  join: no transcripts found to join.')
    return []
  }

  console.log(`\n  Joining transcripts in ${dirs.size} folder(s)`)
  const produced: string[] = []
  for (const dir of [...dirs].sort()) {
    await runJjoin(dir)
    const raw = await findNewestRaw(dir)
    if (raw) produced.push(raw)
  }
  return produced
}

// Summarize each joined "Raw - *.md" into a "Summary - <name>.md" beside it,
// using the same engine and default model (Opus 4.8) as the standalone `summary` command.
// Returns the paths of the summaries actually written (failed ones are skipped).
async function summarizeRawFiles(rawPaths: string[]): Promise<string[]> {
  console.log(`\n  Summarizing ${rawPaths.length} joined file(s) with ${SUMMARY_DEFAULT_MODEL}`)
  const written: string[] = []
  for (const raw of rawPaths) {
    const stem = basename(raw, '.md').replace(/^Raw - /, '')
    const outputPath = join(dirname(raw), `Summary - ${stem}.md`)
    try {
      console.log(`\n  ${basename(raw)} → ${basename(outputPath)}`)
      const result = await summarizeFile(raw)
      await writeFile(outputPath, buildSummaryDocument(raw, result), 'utf-8')
      process.stderr.write(`  Saved: ${basename(outputPath)}\n`)
      written.push(outputPath)
    } catch (err) {
      console.error(`  Summary failed: ${basename(raw)} — ${err instanceof Error ? err.message : err}`)
    }
  }
  return written
}

// Copy the result file path(s) to the clipboard, each quoted, newline-separated —
// ready to paste straight back into a shell command.
async function copyResultPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const ok = await copyToClipboard(paths.map((p) => `"${p}"`).join('\n'))
  if (ok) {
    const label = paths.length === 1 ? 'path' : `${paths.length} paths`
    console.log(`  Copied result ${label} to clipboard`)
  }
}

// Folder post-processing: join transcripts (if requested), optionally summarize the joined
// files, then copy the final result path(s) to the clipboard. --summary implies the join step,
// since the summary is built from the joined file.
async function postProcess(files: string[], options: CliOptions): Promise<void> {
  if (!options.jjoin && !options.summary) return
  const raws = await joinTranscripts(files)
  const results = options.summary && raws.length > 0 ? await summarizeRawFiles(raws) : raws
  if (options.copy) await copyResultPaths(results)
}

async function transcribeOne(
  input: string,
  outputPath: string,
  options: CliOptions,
): Promise<void> {
  const result = await transcribe(input, {
    timestamps: options.timestamps,
  })

  await writeFile(outputPath, result.markdown, 'utf-8')
  process.stderr.write(`  Saved: ${basename(outputPath)}\n`)
}

// Delete the downloaded media files in a tree (transcripts and joined output are kept).
// Used when --keep is off, so a run leaves only the transcripts behind.
async function deleteMediaFiles(dir: string, keepExisting: Set<string>): Promise<void> {
  const files = (await collectFiles(dir)).filter((f) => !keepExisting.has(f))
  let removed = 0
  for (const f of files) {
    try {
      await unlink(f)
      removed++
    } catch {
      // best-effort cleanup
    }
  }
  if (removed) console.log(`  Removed ${removed} downloaded media file(s) — pass --keep to preserve`)
}

// Transcribe everything in `dir`, then (unless --keep) delete only the media THIS run downloaded —
// leaving transcripts and any media that already lived in a reused dest folder untouched.
async function transcribeAndClean(dir: string, options: CliOptions, preexisting: Set<string>): Promise<void> {
  await runTranscription(dir, options)
  if (!options.keep) await deleteMediaFiles(dir, preexisting)
}

async function runYouTube(url: string, options: CliOptions, dest?: string): Promise<void> {
  if (options.dry) {
    process.stderr.write('  Fetching video info...\n')
    const info = await getYouTubeInfo(url)
    const est = await estimateCost(url)
    console.log(`\n  YouTube: ${info.title}`)
    console.log(`   Duration: ${formatTimestamp(info.duration)}`)
    console.log(`   Cost (AssemblyAI): ~$${est.cost.toFixed(2)}`)
    return
  }

  process.stderr.write('  Fetching video info...\n')
  const info = await getYouTubeInfo(url)
  const baseDir = dest ? resolve(dest) : null
  if (baseDir) await mkdir(baseDir, { recursive: true })
  const outDir = baseDir ?? process.cwd()
  // With a dest folder, output is title-named inside it; otherwise honor -o, else title in cwd.
  const explicitOut = baseDir ? undefined : options.output
  const stem = explicitOut ? explicitOut.replace(/\.md$/i, '') : sanitizeFilename(info.title)
  const outputPath = explicitOut ?? join(outDir, `${stem}.md`)

  console.log(`\n  YouTube: ${info.title}`)
  const t = performance.now()
  // --keep: download the full video and transcribe from it (preserved).
  // Default: audio-only transient — transcribe() downloads audio, transcribes, then deletes it.
  let videoPath: string | null = null
  if (options.keep) {
    console.log(`  Downloading video → ${stem}.mp4`)
    videoPath = await downloadVideo(url, join(outDir, stem))
  }
  await transcribeOne(videoPath ?? url, outputPath, options)
  const elapsed = (performance.now() - t) / 1000
  console.log(`\n${'─'.repeat(50)}`)
  if (videoPath) console.log(`  Video:      ${videoPath}`)
  console.log(`  Transcript: ${outputPath}`)
  console.log(`Done in ${formatTimestamp(elapsed)}`)
}

async function runPlaylist(url: string, options: CliOptions, dest?: string): Promise<void> {
  process.stderr.write('  Fetching playlist info...\n')
  const info = await getPlaylistInfo(url)
  const count = info.entries.length
  console.log(`\n  Playlist: ${info.title} (${count} video${count === 1 ? '' : 's'})`)

  if (count === 0) {
    console.error('  No videos found in playlist.')
    process.exit(1)
  }

  if (options.dry) {
    printDurationCostEstimate(info.entries.map((e) => e.duration))
    return
  }

  const dir = dest ? resolve(dest) : resolve(sanitizeFilename(info.title))
  await mkdir(dir, { recursive: true })
  const preexisting = new Set(await collectFiles(dir))
  console.log(`  Downloading ${count} item(s) (${options.keep ? 'video' : 'audio'}) → ${dir}`)
  try {
    await downloadPlaylist(url, dir, options.keep)
  } catch (err) {
    // Private/unavailable videos make yt-dlp exit non-zero even when the rest downloaded fine.
    // Don't abort the run — transcribe whatever landed.
    console.error(
      `  Some items could not be downloaded (private/unavailable); transcribing the rest. (${err instanceof Error ? err.message : err})`,
    )
  }
  // Transcribe (--concurrency, skip-already-done, --jjoin/--summary), then drop this run's downloads unless --keep.
  await transcribeAndClean(dir, options, preexisting)
}

// Input is a .md/.txt file listing YouTube links: extract them, download each (video → file,
// playlist → subfolder) into a "<file stem>/" folder, then transcribe the whole tree.
async function runLinkFile(filePath: string, options: CliOptions, dest?: string): Promise<void> {
  const text = await readFile(filePath, 'utf-8')
  const urls = extractYouTubeUrls(text)
  if (urls.length === 0) {
    console.error(`  No YouTube links found in ${basename(filePath)}`)
    process.exit(1)
  }

  const playlists: string[] = []
  const videos: string[] = []
  for (const u of urls) (isYouTubePlaylistUrl(u) ? playlists : videos).push(u)
  console.log(
    `\n  ${basename(filePath)}: ${urls.length} link(s) — ${videos.length} video(s), ${playlists.length} playlist(s)`,
  )

  if (options.dry) {
    const durations: Array<number | null> = []
    for (const u of videos) {
      try {
        durations.push((await getYouTubeInfo(u)).duration)
      } catch {
        durations.push(null)
      }
    }
    for (const u of playlists) {
      try {
        for (const e of (await getPlaylistInfo(u)).entries) durations.push(e.duration)
      } catch {
        durations.push(null)
      }
    }
    printDurationCostEstimate(durations)
    return
  }

  const dir = dest ? resolve(dest) : resolve(sanitizeFilename(basename(filePath, extname(filePath))))
  await mkdir(dir, { recursive: true })
  const preexisting = new Set(await collectFiles(dir))
  console.log(`  Output folder: ${dir} (${options.keep ? 'video' : 'audio'})`)

  let dlFailed = 0
  const groups = [
    { label: 'video', urls: videos, download: downloadVideoInto },
    { label: 'playlist', urls: playlists, download: downloadPlaylistInto },
  ]
  for (const group of groups) {
    for (let i = 0; i < group.urls.length; i++) {
      console.log(`\n  [${group.label} ${i + 1}/${group.urls.length}] ${group.urls[i]}`)
      try {
        await group.download(group.urls[i], dir, options.keep)
      } catch (err) {
        dlFailed++
        console.error(`  Download failed: ${group.urls[i]} — ${err instanceof Error ? err.message : err}`)
      }
    }
  }
  if (dlFailed) console.error(`\n  ${dlFailed} download(s) failed; transcribing what was downloaded.`)

  // Transcribe the whole downloaded tree (recursive), then drop this run's downloads unless --keep.
  await transcribeAndClean(dir, options, preexisting)
}

async function runDryEstimate(inputPath: string, options: CliOptions): Promise<void> {
  const info = await stat(inputPath)

  let files: string[]
  if (info.isDirectory()) {
    files = await collectFiles(inputPath)
  } else {
    files = [resolve(inputPath)]
  }

  if (files.length === 0) {
    console.error(`No supported media files found in: ${inputPath}`)
    process.exit(1)
  }

  const { pending: withAudioCheck, skipped } = await filterPendingFiles(files)

  // Further filter out files without audio streams
  const pending: string[] = []
  let noAudio = 0
  for (const f of withAudioCheck) {
    if (!(await hasAudioStream(f))) {
      noAudio++
    } else {
      pending.push(f)
    }
  }

  const total = files.length
  const base = info.isDirectory() ? inputPath : resolve(inputPath, '..')

  console.log(`\n  ${inputPath} (dry run)`)
  const parts = [`${total} media file(s)`, `${pending.length} to process`, `${skipped} already done`]
  if (noAudio) parts.push(`${noAudio} no audio`)
  console.log(`   ${parts.join(', ')}\n`)

  if (pending.length === 0) {
    console.log('   Nothing to do.')
    return
  }

  const estimates: Array<{ file: string; duration: number; cost: number }> = []
  for (const f of pending) {
    try {
      const est = await estimateCost(f)
      estimates.push({ file: f, ...est })
    } catch {
      console.error(`   Warning: could not determine duration for ${basename(f)}, skipping`)
    }
  }

  if (estimates.length === 0) {
    console.log('   Nothing to estimate.')
    return
  }

  const nameWidth = Math.max(
    4,
    ...estimates.map((e) => (info.isDirectory() ? relative(base, e.file) : basename(e.file)).length),
  )

  console.log(`   ${'File'.padEnd(nameWidth)}  Duration`)

  let totalDuration = 0
  let totalCost = 0
  for (const est of estimates) {
    const name = info.isDirectory() ? relative(base, est.file) : basename(est.file)
    console.log(`   ${name.padEnd(nameWidth)}  ${formatTimestamp(est.duration)}`)
    totalDuration += est.duration
    totalCost += est.cost
  }

  console.log(`   ${'─'.repeat(nameWidth + 12)}`)
  console.log(`   ${'Total duration:'.padEnd(nameWidth + 2)} ${formatTimestamp(totalDuration)} (${(totalDuration / 60).toFixed(1)} min)`)
  console.log(`   ${'Total cost (AssemblyAI):'.padEnd(nameWidth + 2)} ~$${totalCost.toFixed(2)}`)
}

async function runTranscription(inputPath: string, options: CliOptions): Promise<void> {
  const info = await stat(inputPath)

  if (info.isFile()) {
    if (options.jjoin || options.summary) {
      console.error(`Error: ${pipelineLabel(options)} requires a folder input (nothing to join for a single file)`)
      process.exit(1)
    }
    const outputPath = options.output ?? inputPath.replace(extname(inputPath), '.md')
    console.log(`\n  ${basename(inputPath)}`)
    const t = performance.now()
    await transcribeOne(inputPath, outputPath, options)
    const elapsed = (performance.now() - t) / 1000
    console.log(`\n${'─'.repeat(50)}`)
    console.log(`Done in ${formatTimestamp(elapsed)}`)
    return
  }

  // Directory mode
  const files = await collectFiles(inputPath)
  if (files.length === 0) {
    console.error(`No supported media files found in: ${inputPath}`)
    process.exit(1)
  }

  const { pending, skipped } = await filterPendingFiles(files)
  const total = files.length
  console.log(`\n  ${inputPath}`)
  console.log(`   ${total} media file(s) found, ${pending.length} to process, ${skipped} already done\n`)
  console.log('─'.repeat(50))

  if (pending.length === 0) {
    console.log('Nothing to do — all files already transcribed.')
    await postProcess(files, options)
    return
  }

  let processed = 0
  let failed = 0
  let noAudio = 0
  const t = performance.now()

  // Process with concurrency limit
  const limit = options.concurrency
  const queue = [...pending]

  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift()!
      const name = relative(inputPath, f)
      const outputPath = f.replace(extname(f), '.md')

      try {
        if (!(await hasAudioStream(f))) {
          noAudio++
          process.stderr.write(`  Skipped (no audio): ${name}\n`)
          continue
        }
        console.log(`\n  ${name}`)
        await transcribeOne(f, outputPath, options)
        processed++
      } catch (err) {
        failed++
        console.error(`  Failed: ${name} — ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, pending.length) }, () => worker()))

  const elapsed = (performance.now() - t) / 1000
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Done in ${formatTimestamp(elapsed)}`)
  const summary = [`${processed} transcribed`, `${skipped} skipped`]
  if (noAudio) summary.push(`${noAudio} no audio`)
  if (failed) summary.push(`${failed} failed`)
  summary.push(`${total} total`)
  console.log(`   ${summary.join(', ')}`)

  if (options.jjoin || options.summary) {
    if (failed > 0) {
      console.error(
        `\n  ${pipelineLabel(options)} skipped: ${failed} file(s) failed to transcribe — joined output would be incomplete.` +
          '\n  Re-run the same command; already-done files are skipped automatically.',
      )
      process.exitCode = 1
      return
    }
    await postProcess(files, options)
  }
}

const HELP_OVERVIEW = `
Commands (this toolkit installs two global binaries):
  mediascribe <input> [dest]   Transcribe to Markdown via AssemblyAI (see Options above).
                               input = media file · folder (recursive) · YouTube video URL
                               · YouTube playlist URL · a .md/.txt listing YouTube links.
  summary <path>               Summarize a .pdf/.md/.txt (or a folder's joined "Raw - *.md")
                               into a Markdown конспект via OpenRouter. Run: summary --help

Pipelines:
  mediascribe ./folder --jjoin     transcribe, then merge per folder  ->  "Raw - *.md"
  mediascribe ./folder --summary   transcribe -> merge -> summarize   ->  "Summary - *.md"
  summary ./folder                 summarize a folder's already-joined "Raw - *.md"

Examples:
  mediascribe lecture.mp4
  mediascribe "https://youtube.com/watch?v=..."                 # transcript only (audio deleted)
  mediascribe --keep "https://youtube.com/watch?v=..." ~/talks  # keep the .mp4 in ~/talks
  mediascribe "https://www.youtube.com/playlist?list=..." --dry
  mediascribe ./links.md ~/archive
  summary report.pdf

Requirements:
  ASSEMBLYAI_API_KEY   required for transcription (mediascribe)
  OPENROUTER_API_KEY   required for summaries (summary / --summary)
  yt-dlp + ffmpeg      required for YouTube downloads + audio processing
`

const program = new Command()
  .name('mediascribe')
  .description('Transcribe audio/video, YouTube videos, playlists, and link-lists to Markdown (AssemblyAI)')
  .argument('[input]', 'Path to file/folder or YouTube video/playlist URL, or a .md/.txt of links (omit to show help)')
  .argument('[dest]', 'Output folder for media + transcripts (YouTube/link inputs; default: current dir / auto-named)')
  .option('-o, --output <path>', 'Output markdown file (ignored for folders)')
  .option('--timestamps', 'Include timestamps in output', false)
  .option('--concurrency <n>', 'Parallel transcription jobs', (v) => parseInt(v, 10), 3)
  .option('--dry', 'Estimate cost without transcribing', false)
  .option('--force-ass', '(deprecated, no-op) AssemblyAI is always used now', false)
  .option('--keep', 'Keep the downloaded video(s) after transcribing (default: audio-only, deleted)', false)
  .option(
    '--jjoin',
    'After transcribing a folder, join transcripts via jjoin (md-join.sh) into "Raw - *.md" + PDF, one per folder with transcripts',
    false,
  )
  .option(
    '--summary',
    `After transcribing and joining, summarize each joined file into "Summary - <name>.md" (via ${SUMMARY_DEFAULT_MODEL}). Implies --jjoin; folder input only`,
    false,
  )
  .option('--no-copy', 'Do not copy the result file path(s) to the clipboard (wl-copy)')
  .option('--set-key <key>', 'Save the AssemblyAI API key to .env and exit (overwrites any existing key)')
  .addHelpText('after', HELP_OVERVIEW)
  .action(async (input: string | undefined, dest: string | undefined, opts: CliOptions) => {
    if (opts.setKey !== undefined) {
      try {
        await setAssemblyAIKey(opts.setKey)
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
      return
    }
    if (!input || input === 'help') {
      program.help()
      return
    }
    if (isYouTubePlaylistUrl(input)) {
      await runPlaylist(input, opts, dest)
      return
    }

    if (isYouTubeUrl(input)) {
      if (opts.jjoin || opts.summary) {
        console.error(
          `Error: ${pipelineLabel(opts)} requires a folder or playlist URL, not a single video`,
        )
        process.exit(1)
      }
      await runYouTube(input, opts, dest)
      return
    }

    const inputPath = resolve(input)

    if (!(await fileExists(inputPath))) {
      console.error(`Error: path not found: ${inputPath}`)
      process.exit(1)
    }

    // A .md/.txt file is a list of links to download + transcribe (not a media file).
    const ext = extname(inputPath).toLowerCase()
    if ((ext === '.md' || ext === '.txt') && (await stat(inputPath)).isFile()) {
      await runLinkFile(inputPath, opts, dest)
      return
    }

    // Local file/folder: transcripts are written beside their sources, so a dest folder doesn't apply.
    if (dest) {
      console.error('  Note: a destination folder is ignored for local files/folders (transcripts go beside the media).')
    }

    if (opts.dry) {
      await runDryEstimate(inputPath, opts)
    } else {
      await runTranscription(inputPath, opts)
    }
  })

program.parse()
