import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { unlink, stat } from 'node:fs/promises'
import OpenAI from 'openai'
import { compressAudio } from '../audio.js'
import type { Paragraph } from '../types.js'
import { DEFAULT_MODEL } from '../types.js'

const AUDIO_TOKEN_RATE = 32 // Gemini: 32 tokens per second of audio
const MAX_UPLOAD_MB = 100
const MAX_OUTPUT_TOKENS = 65536
const TOKENS_PER_MILLION = 1_000_000
const INPUT_PRICE_PER_M = 0.10  // Gemini Flash input pricing (USD)
const OUTPUT_PRICE_PER_M = 0.40 // Gemini Flash output pricing (USD)

const MODEL_AUDIO_PRICING: Record<string, number> = {
  'google/gemini-3-flash-preview': 1.00,
  'google/gemini-2.5-flash': 1.00,
  'google/gemini-2.5-pro': 1.25,
  'google/gemini-2.0-flash-001': 0.70,
}

const TRANSCRIPTION_PROMPT = `\
Transcribe the following audio into text. Return ONLY a JSON array of objects, each with:
- "time": timestamp in "HH:MM:SS" format (approximate start time of the paragraph)
- "text": the transcribed text for that paragraph

Group the text into natural paragraphs (every few sentences or at topic changes).
Do not include any other text, markdown formatting, or code fences — just the raw JSON array.

Example output format:
[
  {"time": "00:00:00", "text": "Welcome to today's lecture. We'll be covering..."},
  {"time": "00:02:15", "text": "The first topic is..."}
]`

function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

function parseResponse(text: string): Paragraph[] {
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/, '')
  cleaned = cleaned.replace(/\s*```$/, '')

  let data: Array<{ time?: string; text?: string }>
  try {
    data = JSON.parse(cleaned)
  } catch {
    throw new Error(`Failed to parse cloud transcription response as JSON`)
  }

  return data
    .filter((item) => item.text?.trim())
    .map((item) => ({
      text: item.text!.trim(),
      timestamp: parseTimestamp(item.time ?? '00:00:00'),
    }))
}

export function estimateCostOpenRouter(
  durationSecs: number,
  model: string = DEFAULT_MODEL,
): number {
  const audioTokens = Math.floor(durationSecs * AUDIO_TOKEN_RATE)
  const outputTokens = Math.floor((durationSecs / 60) * 200)
  const pricePerM = MODEL_AUDIO_PRICING[model] ?? 1.0
  const audioCost = (audioTokens / TOKENS_PER_MILLION) * pricePerM
  const outputCost = (outputTokens / TOKENS_PER_MILLION) * OUTPUT_PRICE_PER_M
  return audioCost + outputCost
}

export async function transcribeOpenRouter(
  inputPath: string,
  apiKey: string,
  options: { model?: string },
): Promise<{ paragraphs: Paragraph[] }> {
  const model = options.model ?? DEFAULT_MODEL

  // Compress to 32kbps MP3
  const tmpMp3 = join(tmpdir(), `mediascribe-${randomUUID()}.mp3`)
  try {
    process.stderr.write('  Compressing audio...')
    const t = performance.now()
    await compressAudio(inputPath, tmpMp3)

    const { size } = await stat(tmpMp3)
    const sizeMb = size / (1024 * 1024)
    process.stderr.write(` done (${((performance.now() - t) / 1000).toFixed(1)}s, ${sizeMb.toFixed(1)}MB)\n`)

    if (sizeMb > MAX_UPLOAD_MB) {
      throw new Error(`Compressed audio too large (${sizeMb.toFixed(0)}MB > ${MAX_UPLOAD_MB}MB limit)`)
    }

    // Base64-encode
    const audioBuffer = await readFile(tmpMp3)
    const audioB64 = audioBuffer.toString('base64')

    const prompt = TRANSCRIPTION_PROMPT

    // Call OpenRouter API
    process.stderr.write('  Sending to OpenRouter...')
    const t2 = performance.now()

    const client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey,
      timeout: 300_000,
    })

    const response = await client.chat.completions.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'input_audio' as 'text',
              input_audio: { data: audioB64, format: 'mp3' },
            } as any,
          ],
        },
      ],
    })

    const elapsed = ((performance.now() - t2) / 1000).toFixed(1)
    process.stderr.write(` done (${elapsed}s)\n`)

    const reply = response.choices[0]?.message?.content ?? ''
    const paragraphs = parseResponse(reply)

    const usage = response.usage
    if (usage) {
      const costIn = (usage.prompt_tokens / TOKENS_PER_MILLION) * INPUT_PRICE_PER_M
      const costOut = (usage.completion_tokens / TOKENS_PER_MILLION) * OUTPUT_PRICE_PER_M
      process.stderr.write(`  Tokens: ${usage.prompt_tokens} in / ${usage.completion_tokens} out (~$${(costIn + costOut).toFixed(4)})\n`)
    }

    return { paragraphs }
  } finally {
    await unlink(tmpMp3).catch(() => {})
  }
}
