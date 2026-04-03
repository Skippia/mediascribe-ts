import { basename } from 'node:path'
import { getDuration, hasAudioStream } from './audio.js'
import { transcribeOpenRouter, estimateCostOpenRouter } from './backends/openrouter.js'
import { transcribeAssemblyAI, estimateCostAssemblyAI } from './backends/assemblyai.js'
import { isYouTubeUrl, getYouTubeInfo, downloadAudio } from './youtube.js'
import { buildMarkdown, formatTimestamp } from './markdown.js'
import {
  DURATION_THRESHOLD,
  DEFAULT_MODEL,
  type TranscribeOptions,
  type TranscribeResult,
  type CostEstimate,
} from './types.js'

function resolveKeys(options?: TranscribeOptions) {
  const openrouterApiKey = options?.openrouterApiKey ?? process.env.OPENROUTER_API_KEY
  const assemblyaiApiKey = options?.assemblyaiApiKey ?? process.env.ASSEMBLYAI_API_KEY
  if (!openrouterApiKey || !assemblyaiApiKey) {
    throw new Error('Both OPENROUTER_API_KEY and ASSEMBLYAI_API_KEY must be set (env or options)')
  }
  return { openrouterApiKey, assemblyaiApiKey }
}

async function transcribeAudioFile(
  audioPath: string,
  inputName: string,
  keys: { openrouterApiKey: string; assemblyaiApiKey: string },
  options?: TranscribeOptions,
): Promise<TranscribeResult> {
  const duration = await getDuration(audioPath)
  if (duration === null) {
    throw new Error(`Failed to determine duration: ${audioPath}`)
  }
  const model = options?.cloudModel ?? DEFAULT_MODEL
  const backend = (options?.forceAssemblyai || duration >= DURATION_THRESHOLD) ? 'assemblyai' : 'openrouter'

  process.stderr.write(`  Routing to ${backend === 'openrouter' ? 'OpenRouter' : 'AssemblyAI'} (${formatTimestamp(duration)})\n`)

  const { paragraphs } = backend === 'assemblyai'
    ? await transcribeAssemblyAI(audioPath, keys.assemblyaiApiKey)
    : await transcribeOpenRouter(audioPath, keys.openrouterApiKey, { model })

  const markdown = buildMarkdown(inputName, paragraphs, {
    timestamps: options?.timestamps,
    duration,
    backend,
  })

  return { paragraphs, markdown, duration, backend }
}

export async function transcribe(
  input: string,
  options?: TranscribeOptions,
): Promise<TranscribeResult> {
  const keys = resolveKeys(options)

  if (isYouTubeUrl(input)) {
    process.stderr.write('  Fetching video info...\n')
    const info = await getYouTubeInfo(input)
    process.stderr.write(`  Title: ${info.title}\n`)
    process.stderr.write(`  Duration: ${formatTimestamp(info.duration)}\n`)

    process.stderr.write('  Downloading audio...\n')
    const { audioPath, cleanup } = await downloadAudio(input)

    try {
      return await transcribeAudioFile(audioPath, info.title, keys, options)
    } finally {
      await cleanup()
    }
  }

  // Local file
  if (!(await hasAudioStream(input))) {
    throw new Error(`No audio stream found: ${input}`)
  }

  const inputName = basename(input)
  return transcribeAudioFile(input, inputName, keys, options)
}

export async function estimateCost(
  input: string,
  options?: Pick<TranscribeOptions, 'cloudModel'>,
): Promise<CostEstimate> {
  let duration: number

  if (isYouTubeUrl(input)) {
    const info = await getYouTubeInfo(input)
    duration = info.duration
  } else {
    const d = await getDuration(input)
    if (d === null) throw new Error(`Failed to determine duration: ${input}`)
    duration = d
  }

  const model = options?.cloudModel ?? DEFAULT_MODEL
  const backend = duration >= DURATION_THRESHOLD ? 'assemblyai' : 'openrouter'
  const cost =
    backend === 'assemblyai'
      ? estimateCostAssemblyAI(duration)
      : estimateCostOpenRouter(duration, model)

  return { duration, backend, cost }
}
