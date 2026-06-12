#!/usr/bin/env node

import { resolve, extname, relative, basename, dirname, join } from 'node:path'
import { writeFile, readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { config } from 'dotenv'
import { Command } from 'commander'
import { transcribe, estimateCost } from './transcribe.js'
import { summarizeFile, buildSummaryDocument } from './summarize.js'
import { fileExists, copyToClipboard } from './util.js'
import { hasAudioStream } from './audio.js'
import { isYouTubeUrl, getYouTubeInfo } from './youtube.js'
import { formatTimestamp } from './markdown.js'
import { DEFAULT_MODEL, SUMMARY_DEFAULT_MODEL, SUPPORTED_EXTENSIONS } from './types.js'

// Load .env from script directory
config({ path: new URL('../.env', import.meta.url).pathname })

interface CliOptions {
  output?: string
  timestamps: boolean
  model: string
  concurrency: number
  dry: boolean
  forceAss: boolean
  jjoin: boolean
  summary: boolean
  copy: boolean
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
    cloudModel: options.model,
    forceAssemblyai: options.forceAss,
  })

  await writeFile(outputPath, result.markdown, 'utf-8')
  process.stderr.write(`  Saved: ${basename(outputPath)}\n`)
}

async function runYouTube(url: string, options: CliOptions): Promise<void> {
  if (options.dry) {
    process.stderr.write('  Fetching video info...\n')
    const info = await getYouTubeInfo(url)
    const est = await estimateCost(url, { cloudModel: options.model })
    console.log(`\n  YouTube: ${info.title}`)
    console.log(`   Duration: ${formatTimestamp(info.duration)}`)
    console.log(`   Backend:  ${est.backend === 'assemblyai' ? 'AssemblyAI' : 'OpenRouter'}`)
    console.log(`   Cost:     ~$${est.cost.toFixed(2)}`)
    return
  }

  const outputPath = options.output ?? sanitizeFilename((await getYouTubeInfo(url)).title) + '.md'
  console.log(`\n  YouTube → ${basename(outputPath)}`)
  const t = performance.now()
  await transcribeOne(url, outputPath, options)
  const elapsed = (performance.now() - t) / 1000
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Done in ${formatTimestamp(elapsed)}`)
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

  const estimates: Array<{ file: string; duration: number; backend: string; cost: number }> = []
  for (const f of pending) {
    try {
      const est = await estimateCost(f, { cloudModel: options.model })
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

  console.log(`   ${'File'.padEnd(nameWidth)}  ${'Duration'.padEnd(10)}  Backend`)

  let openrouterCost = 0
  let assemblyaiCost = 0
  let openrouterDuration = 0
  let assemblyaiDuration = 0

  for (const est of estimates) {
    const name = info.isDirectory() ? relative(base, est.file) : basename(est.file)
    const label = est.backend === 'assemblyai' ? 'AssemblyAI' : 'OpenRouter'
    console.log(`   ${name.padEnd(nameWidth)}  ${formatTimestamp(est.duration).padEnd(10)}  ${label}`)
    if (est.backend === 'assemblyai') {
      assemblyaiCost += est.cost
      assemblyaiDuration += est.duration
    } else {
      openrouterCost += est.cost
      openrouterDuration += est.duration
    }
  }

  const totalDuration = openrouterDuration + assemblyaiDuration
  const totalCost = openrouterCost + assemblyaiCost

  console.log(`   ${'─'.repeat(nameWidth + 24)}`)
  console.log(`   ${'Total duration:'.padEnd(nameWidth + 2)} ${formatTimestamp(totalDuration)} (${(totalDuration / 60).toFixed(1)} min)`)
  if (openrouterDuration > 0)
    console.log(`   ${'OpenRouter:'.padEnd(nameWidth + 2)} ${formatTimestamp(openrouterDuration)} — ~$${openrouterCost.toFixed(2)} (${options.model})`)
  if (assemblyaiDuration > 0)
    console.log(`   ${'AssemblyAI:'.padEnd(nameWidth + 2)} ${formatTimestamp(assemblyaiDuration)} — ~$${assemblyaiCost.toFixed(2)}`)
  console.log(`   ${'Total cost:'.padEnd(nameWidth + 2)} ~$${totalCost.toFixed(2)}`)
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

const program = new Command()
  .name('mediascribe')
  .description('Transcribe video/audio files to markdown (cloud-based, auto-routed)')
  .argument('<input>', 'Path to file/folder or YouTube URL')
  .option('-o, --output <path>', 'Output markdown file (ignored for folders)')
  .option('--timestamps', 'Include timestamps in output', false)
  .option('--model <model>', 'OpenRouter model for files <30m', DEFAULT_MODEL)
  .option('--concurrency <n>', 'Parallel transcription jobs', (v) => parseInt(v, 10), 3)
  .option('--dry', 'Estimate cost without transcribing', false)
  .option('--force-ass', 'Force AssemblyAI for all files regardless of duration', false)
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
  .action(async (input: string, opts: CliOptions) => {
    if (isYouTubeUrl(input)) {
      if (opts.jjoin || opts.summary) {
        console.error(`Error: ${pipelineLabel(opts)} requires a folder input, not a YouTube URL`)
        process.exit(1)
      }
      await runYouTube(input, opts)
      return
    }

    const inputPath = resolve(input)

    if (!(await fileExists(inputPath))) {
      console.error(`Error: path not found: ${inputPath}`)
      process.exit(1)
    }

    if (opts.dry) {
      await runDryEstimate(inputPath, opts)
    } else {
      await runTranscription(inputPath, opts)
    }
  })

program.parse()
