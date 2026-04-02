import { AssemblyAI } from 'assemblyai'
import { resolve } from 'node:path'
import type { Paragraph } from '../types.js'

const PRICE_PER_MIN = 0.0065 // USD

export function estimateCostAssemblyAI(durationSecs: number): number {
  return (durationSecs / 60) * PRICE_PER_MIN
}

export async function transcribeAssemblyAI(
  inputPath: string,
  apiKey: string,
): Promise<{ paragraphs: Paragraph[] }> {
  const client = new AssemblyAI({ apiKey })

  process.stderr.write('  Sending to AssemblyAI...')
  const t = performance.now()

  const transcript = await client.transcripts.transcribe({
    audio: resolve(inputPath),
    speech_models: ['universal-3-pro', 'universal-2'],
    language_detection: true,
  } as any)

  const elapsed = ((performance.now() - t) / 1000).toFixed(1)
  process.stderr.write(` done (${elapsed}s)\n`)

  if (transcript.status === 'error') {
    throw new Error(`AssemblyAI transcription failed: ${transcript.error}`)
  }

  // Get paragraphs
  const rawParagraphs = await client.transcripts.paragraphs(transcript.id)

  const paragraphs: Paragraph[] = rawParagraphs.paragraphs
    .filter((p) => p.text?.trim())
    .map((p) => ({
      text: p.text.trim(),
      timestamp: (p.start ?? 0) / 1000,
    }))

  if (paragraphs.length === 0 && transcript.text) {
    paragraphs.push({ text: transcript.text, timestamp: 0 })
  }

  process.stderr.write(`  Done | ${paragraphs.length} paragraphs\n`)

  return { paragraphs }
}
