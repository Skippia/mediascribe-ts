import { readFile } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import { spawn } from 'node:child_process'
import type OpenAI from 'openai'
import { createOpenRouterClient } from './backends/openrouter.js'
import {
  SUMMARY_DEFAULT_MODEL,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_SINGLE_PASS_TOKEN_LIMIT,
  SUMMARY_CHUNK_TOKEN_SIZE,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_USER_PROMPT,
  SUMMARY_TEXT_EXTENSIONS,
  type SummaryOptions,
} from './types.js'

// Longer than the transcription timeout: map-reduce can chain several large calls.
const REQUEST_TIMEOUT_MS = 600_000

export interface SummaryResult {
  markdown: string
  model: string
  chunks: number
  sourceChars: number
}

/** Rough token estimate: ~4 characters per token. Used only for routing/cost, never billed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Assemble the final Markdown document: a small provenance header + the model's конспект. */
export function buildSummaryDocument(inputPath: string, result: SummaryResult): string {
  const date = new Date().toISOString().slice(0, 10)
  const note = result.chunks > 1 ? ` · ${result.chunks} chunks (map-reduce)` : ''
  const header = [
    `# Конспект: ${basename(inputPath)}`,
    '',
    `> Источник: ${inputPath} · Модель: ${result.model} · ${date}${note}`,
    '',
  ].join('\n')
  return header + result.markdown + '\n'
}

/** Extract plain text from a .pdf (via pdftotext) or read .md/.txt directly as UTF-8. */
export async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()

  if (SUMMARY_TEXT_EXTENSIONS.has(ext)) {
    return readFile(filePath, 'utf-8')
  }

  if (ext === '.pdf') {
    return extractPdfText(filePath)
  }

  const supported = ['.pdf', ...SUMMARY_TEXT_EXTENSIONS].join(', ')
  throw new Error(`Unsupported file type "${ext}". Supported: ${supported}`)
}

function extractPdfText(pdfPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // "-nopgbrk": no form-feed page-break chars. "-" writes extracted text to stdout.
    const child = spawn('pdftotext', ['-nopgbrk', pdfPath, '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(
        e.code === 'ENOENT'
          ? new Error('pdftotext not found. Install it: sudo pacman -S poppler (or apt install poppler-utils)')
          : e,
      )
    })
    child.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf-8'))
      else reject(new Error(`pdftotext exited with code ${code}: ${Buffer.concat(err).toString('utf-8').trim()}`))
    })
  })
}

function resolveApiKey(options: SummaryOptions): string {
  const key = options.openrouterApiKey ?? process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY must be set (env, .env, or options)')
  return key
}

/** Split text into chunks of roughly `chunkTokens`, preferring paragraph boundaries. */
export function chunkText(text: string, chunkTokens: number): string[] {
  const maxChars = chunkTokens * 4
  const paragraphs = text.split(/\n\s*\n/)
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    // A single paragraph larger than the budget is hard-split on character count.
    if (para.length > maxChars) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars))
      }
      continue
    }
    if (current.length + para.length + 2 > maxChars) {
      chunks.push(current)
      current = para
    } else {
      current = current ? `${current}\n\n${para}` : para
    }
  }
  if (current) chunks.push(current)
  return chunks
}

async function callModel(
  client: OpenAI,
  model: string,
  maxTokens: number,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  const res = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  })

  const usage = res.usage
  if (usage) {
    process.stderr.write(`  Tokens: ${usage.prompt_tokens} in / ${usage.completion_tokens} out\n`)
  }

  const out = res.choices[0]?.message?.content?.trim()
  if (!out) {
    const reason = res.choices[0]?.finish_reason ?? 'unknown'
    throw new Error(`Model returned empty content (finish_reason: ${reason})`)
  }
  return out
}

/**
 * Summarize a .pdf/.md/.txt file into a Markdown конспект via OpenRouter.
 * Single pass for normal documents; map-reduce for inputs above the context budget.
 */
export async function summarizeFile(
  filePath: string,
  options: SummaryOptions = {},
): Promise<SummaryResult> {
  const model = options.model ?? SUMMARY_DEFAULT_MODEL
  const maxTokens = options.maxTokens ?? SUMMARY_MAX_OUTPUT_TOKENS
  const systemPrompt = options.systemPrompt ?? SUMMARY_SYSTEM_PROMPT
  const userPrompt = options.userPrompt ?? SUMMARY_USER_PROMPT
  const apiKey = resolveApiKey(options)

  let text = (await extractText(filePath)).trim()
  if (!text) {
    throw new Error(
      `No extractable text in ${basename(filePath)}. ` +
        'A scanned/image-only PDF needs OCR first (e.g. ocrmypdf).',
    )
  }

  const client = createOpenRouterClient(apiKey, REQUEST_TIMEOUT_MS)
  const totalTokens = estimateTokens(text)
  const sourceChars = text.length

  // Single pass — the common case.
  if (totalTokens <= SUMMARY_SINGLE_PASS_TOKEN_LIMIT) {
    process.stderr.write(`  Summarizing (~${totalTokens.toLocaleString()} tokens) with ${model}\n`)
    const markdown = await callModel(client, model, maxTokens, systemPrompt, `${userPrompt}\n\n---\n\n${text}`)
    return { markdown, model, chunks: 1, sourceChars }
  }

  // Map-reduce for oversized inputs (e.g. multi-MB merged transcripts).
  const parts = chunkText(text, SUMMARY_CHUNK_TOKEN_SIZE)
  text = '' // release the full document; only the chunks are needed past this point
  process.stderr.write(
    `  Input ~${totalTokens.toLocaleString()} tokens exceeds single-pass budget — map-reduce over ${parts.length} chunks\n`,
  )

  const partials: string[] = []
  for (let i = 0; i < parts.length; i++) {
    process.stderr.write(`  Chunk ${i + 1}/${parts.length}...\n`)
    const partUserContent = `${userPrompt}\n\n(Это часть ${i + 1} из ${parts.length} большого документа.)\n\n---\n\n${parts[i]}`
    partials.push(await callModel(client, model, maxTokens, systemPrompt, partUserContent))
  }

  process.stderr.write(`  Reducing ${parts.length} partial summaries into one конспект...\n`)
  const reducePrompt =
    `Ниже — ${parts.length} последовательных конспекта частей одного документа. ` +
    'Объедини их в единый связный конспект без повторов и потери идей, сохранив ' +
    'структуру и логику изложения. ' +
    userPrompt
  const reduceContent = `${reducePrompt}\n\n---\n\n${partials.map((p, i) => `## Часть ${i + 1}\n\n${p}`).join('\n\n')}`
  const markdown = await callModel(client, model, maxTokens, systemPrompt, reduceContent)

  return { markdown, model, chunks: parts.length, sourceChars }
}
