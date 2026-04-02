#!/usr/bin/env node

import { resolve, extname, relative, basename } from 'node:path'
import { writeFile, readdir, stat, access } from 'node:fs/promises'
import { config } from 'dotenv'
import { Command } from 'commander'
import { transcribe, estimateCost } from './transcribe.js'
import { hasAudioStream } from './audio.js'
import { isYouTubeUrl, getYouTubeInfo } from './youtube.js'
import { formatTimestamp } from './markdown.js'
import { DEFAULT_MODEL, SUPPORTED_EXTENSIONS } from './types.js'

// Load .env from script directory
config({ path: new URL('../.env', import.meta.url).pathname })

interface CliOptions {
  output?: string
  timestamps: boolean
  model: string
  concurrency: number
  dry: boolean
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
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

async function transcribeOne(
  input: string,
  outputPath: string,
  options: CliOptions,
): Promise<void> {
  const result = await transcribe(input, {
    timestamps: options.timestamps,
    cloudModel: options.model,
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
}

const program = new Command()
  .name('mediascribe')
  .description('Transcribe video/audio files to markdown (cloud-based, auto-routed)')
  .argument('<input>', 'Path to file/folder or YouTube URL')
  .option('-o, --output <path>', 'Output markdown file (ignored for folders)')
  .option('--timestamps', 'Include timestamps in output', false)
  .option('--model <model>', 'OpenRouter model for files <1h', DEFAULT_MODEL)
  .option('--concurrency <n>', 'Parallel transcription jobs', (v) => parseInt(v, 10), 20)
  .option('--dry', 'Estimate cost without transcribing', false)
  .action(async (input: string, opts: CliOptions) => {
    if (isYouTubeUrl(input)) {
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
