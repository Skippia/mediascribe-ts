import { AssemblyAI } from 'assemblyai'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import { compressAudio } from '../audio.js'
import type { Paragraph } from '../types.js'

const PRICE_PER_MIN = 0.0065 // USD

const MAX_ATTEMPTS = 4
const BACKOFF_MS = [10_000, 30_000, 60_000]

// AssemblyAI's /v2/upload endpoint caps local files at 2.2GB and its gateway
// drops uploads that run past ~15min, returning 502 Bad Gateway. We never send
// raw video: compressing to 32kbps mono MP3 first puts even a 10h recording
// (their max duration) at ~150MB, well inside both limits.
const MAX_UPLOAD_BYTES = 2_200_000_000

export function estimateCostAssemblyAI(durationSecs: number): number {
  return (durationSecs / 60) * PRICE_PER_MIN
}

function isTransient(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes('internal server error') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    /\b5\d{2}\b/.test(msg) // any 5xx in the message
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function transcribeAssemblyAI(
  inputPath: string,
  apiKey: string,
): Promise<{ paragraphs: Paragraph[] }> {
  const client = new AssemblyAI({ apiKey })

  // Strip video and downsample to 32kbps mono MP3 before uploading. Sending the
  // raw file would blow past AssemblyAI's 2.2GB upload cap and its ~15min
  // gateway timeout (manifesting as 502 Bad Gateway) on large course videos.
  const tmpMp3 = join(tmpdir(), `mediascribe-ass-${randomUUID()}.mp3`)
  try {
    process.stderr.write('  Compressing audio...')
    const tc = performance.now()
    await compressAudio(inputPath, tmpMp3)
    const { size } = await stat(tmpMp3)
    const sizeMb = size / (1024 * 1024)
    process.stderr.write(
      ` done (${((performance.now() - tc) / 1000).toFixed(1)}s, ${sizeMb.toFixed(1)}MB)\n`,
    )

    if (size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `Compressed audio still exceeds AssemblyAI's 2.2GB upload limit (${sizeMb.toFixed(0)}MB)`,
      )
    }

    return await uploadAndTranscribe(client, tmpMp3)
  } finally {
    await unlink(tmpMp3).catch(() => {})
  }
}

async function uploadAndTranscribe(
  client: AssemblyAI,
  audio: string,
): Promise<{ paragraphs: Paragraph[] }> {
  let lastErr: unknown

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const label = attempt === 1 ? '' : ` (attempt ${attempt}/${MAX_ATTEMPTS})`
    process.stderr.write(`  Sending to AssemblyAI${label}...`)
    const t = performance.now()

    try {
      const transcript = await client.transcripts.transcribe({
        audio,
        speech_models: ['universal-3-pro', 'universal-2'],
        language_detection: true,
      } as any)

      const elapsed = ((performance.now() - t) / 1000).toFixed(1)
      process.stderr.write(` done (${elapsed}s)\n`)

      if (transcript.status === 'error') {
        const errMsg = transcript.error ?? 'unknown error'
        const err = new Error(`AssemblyAI transcription failed: ${errMsg}`)
        if (attempt < MAX_ATTEMPTS && isTransient(errMsg)) {
          lastErr = err
          const wait = BACKOFF_MS[attempt - 1] ?? 60_000
          process.stderr.write(
            `  Transient error: ${errMsg}\n  Retrying in ${wait / 1000}s...\n`,
          )
          await sleep(wait)
          continue
        }
        throw err
      }

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
    } catch (err) {
      const elapsed = ((performance.now() - t) / 1000).toFixed(1)
      process.stderr.write(` failed (${elapsed}s)\n`)
      lastErr = err
      if (attempt < MAX_ATTEMPTS && isTransient(err)) {
        const wait = BACKOFF_MS[attempt - 1] ?? 60_000
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `  Transient error: ${msg}\n  Retrying in ${wait / 1000}s...\n`,
        )
        await sleep(wait)
        continue
      }
      throw err
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error('AssemblyAI transcription failed after retries')
}
