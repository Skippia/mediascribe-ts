import { basename } from 'node:path'
import { getDuration, hasAudioStream } from './audio.js'
import { transcribeAssemblyAI, estimateCostAssemblyAI } from './backends/assemblyai.js'
import { isYouTubeUrl, getYouTubeInfo, downloadAudio } from './youtube.js'
import { buildMarkdown, formatTimestamp } from './markdown.js'
import { type TranscribeOptions, type TranscribeResult, type CostEstimate } from './types.js'

function resolveKey(options?: TranscribeOptions): string {
  const assemblyaiApiKey = options?.assemblyaiApiKey ?? process.env.ASSEMBLYAI_API_KEY
  if (!assemblyaiApiKey) {
    throw new Error('ASSEMBLYAI_API_KEY must be set (env or options)')
  }
  return assemblyaiApiKey
}

async function transcribeAudioFile(
  audioPath: string,
  inputName: string,
  assemblyaiApiKey: string,
  options?: TranscribeOptions,
): Promise<TranscribeResult> {
  const duration = await getDuration(audioPath)
  if (duration === null) {
    throw new Error(`Failed to determine duration: ${audioPath}`)
  }

  process.stderr.write(`  Transcribing with AssemblyAI (${formatTimestamp(duration)})\n`)
  const { paragraphs } = await transcribeAssemblyAI(audioPath, assemblyaiApiKey)

  const markdown = buildMarkdown(inputName, paragraphs, {
    timestamps: options?.timestamps,
    duration,
    backend: 'assemblyai',
  })

  return { paragraphs, markdown, duration, backend: 'assemblyai' }
}

export async function transcribe(
  input: string,
  options?: TranscribeOptions,
): Promise<TranscribeResult> {
  const assemblyaiApiKey = resolveKey(options)

  if (isYouTubeUrl(input)) {
    process.stderr.write('  Fetching video info...\n')
    const info = await getYouTubeInfo(input)
    process.stderr.write(`  Title: ${info.title}\n`)
    process.stderr.write(`  Duration: ${formatTimestamp(info.duration)}\n`)

    process.stderr.write('  Downloading audio...\n')
    const { audioPath, cleanup } = await downloadAudio(input)

    try {
      return await transcribeAudioFile(audioPath, info.title, assemblyaiApiKey, options)
    } finally {
      await cleanup()
    }
  }

  // Local file
  if (!(await hasAudioStream(input))) {
    throw new Error(`No audio stream found: ${input}`)
  }

  const inputName = basename(input)
  return transcribeAudioFile(input, inputName, assemblyaiApiKey, options)
}

export function estimateCostForDuration(durationSecs: number): CostEstimate {
  return {
    duration: durationSecs,
    cost: estimateCostAssemblyAI(durationSecs),
  }
}

export async function estimateCost(input: string): Promise<CostEstimate> {
  let duration: number

  if (isYouTubeUrl(input)) {
    duration = (await getYouTubeInfo(input)).duration
  } else {
    const d = await getDuration(input)
    if (d === null) throw new Error(`Failed to determine duration: ${input}`)
    duration = d
  }

  return estimateCostForDuration(duration)
}
