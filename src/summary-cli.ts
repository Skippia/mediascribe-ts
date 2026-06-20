#!/usr/bin/env node

import { resolve, extname, basename, dirname, join } from 'node:path'
import { writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { config } from 'dotenv'
import { Command } from 'commander'
import { summarizeFile, extractText, estimateTokens, buildSummaryDocument } from './summarize.js'
import { fileExists, copyToClipboard } from './util.js'
import {
  SUMMARY_DEFAULT_MODEL,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_INPUT_PRICE_PER_M,
  SUMMARY_OUTPUT_PRICE_PER_M,
} from './types.js'

// Load .env from the project root (same pattern as cli.ts)
config({ path: new URL('../.env', import.meta.url).pathname })

interface SummaryCliOptions {
  output?: string
  model: string
  maxTokens: number
  system?: string
  prompt?: string
  dry: boolean
  copy: boolean
}

/** A value of "@path" means read the prompt text from that file; otherwise it's the literal text. */
async function resolvePromptArg(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined
  if (value.startsWith('@')) {
    return readFile(resolve(value.slice(1)), 'utf-8')
  }
  return value
}

// Compute the joined-file path that `jjoin <folder>` (md-join.sh) would produce — same
// algorithm: longest common filename prefix of the folder's *.md (excluding "Raw - *.md"),
// brackets stripped, trimmed; falls back to the folder name. Returns null if no .md files.
async function expectedJoinedPath(folder: string): Promise<string | null> {
  const names = (await readdir(folder))
    .filter((n) => n.endsWith('.md') && !n.startsWith('Raw - '))
    .sort()
  if (names.length === 0) return null

  let prefix = names[0].replace(/\.md$/, '')
  for (const n of names) {
    const name = n.replace(/\.md$/, '')
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  prefix = prefix.replace(/[[\]]/g, '').trim()
  if (prefix === '') prefix = basename(folder)

  return join(folder, `Raw - ${prefix}.md`)
}

// When a folder is passed, summarize the already-joined "Raw - ...md" file inside it.
// Does NOT run jjoin — the file must already exist (run `jjoin`/`mediascribe --jjoin` first).
async function resolveInputFile(inputPath: string): Promise<string> {
  if (!(await stat(inputPath)).isDirectory()) return inputPath

  const joined = await expectedJoinedPath(inputPath)
  if (!joined) {
    console.error(`Error: no .md files to join in folder: ${inputPath}`)
    process.exit(1)
  }
  if (!(await fileExists(joined))) {
    console.error(
      `Error: joined file not found: ${basename(joined)}\n` +
        `  Run "jjoin" (or "mediascribe --jjoin") on the folder first to create it.`,
    )
    process.exit(1)
  }
  console.log(`  Folder → joined file: ${basename(joined)}`)
  return joined
}

function defaultOutputPath(inputPath: string): string {
  const dir = dirname(inputPath)
  // Strip a leading "Raw - " so a joined "Raw - Week 1.md" → "Summary - Week 1.md".
  const stem = basename(inputPath, extname(inputPath)).replace(/^Raw - /, '')
  return join(dir, `Summary - ${stem}.md`)
}

async function runDry(inputPath: string, options: SummaryCliOptions): Promise<void> {
  const text = (await extractText(inputPath)).trim()
  const tokens = estimateTokens(text)
  // Cost estimate covers the input pass only; output is capped by --max-tokens.
  const cost = (tok: number, pricePerM: number) => (tok / 1_000_000) * pricePerM
  const inputCost = cost(tokens, SUMMARY_INPUT_PRICE_PER_M)
  const maxOutputCost = cost(options.maxTokens, SUMMARY_OUTPUT_PRICE_PER_M)

  console.log(`\n  ${basename(inputPath)} (dry run)`)
  console.log(`   Characters:   ${text.length.toLocaleString()}`)
  console.log(`   Est. tokens:  ~${tokens.toLocaleString()} (chars / 4)`)
  console.log(`   Model:        ${options.model}`)
  if (options.model === SUMMARY_DEFAULT_MODEL) {
    console.log(`   Est. cost:    ~$${inputCost.toFixed(3)} input + up to ~$${maxOutputCost.toFixed(3)} output`)
  } else {
    console.log(`   Est. cost:    (pricing only computed for ${SUMMARY_DEFAULT_MODEL})`)
  }
  if (text.length === 0) {
    console.log('   Warning: no extractable text (scanned/image-only PDF needs OCR).')
  }
}

const HELP_AFTER = `
Part of the mediascribe toolkit. For the full overview of commands and flags
(including transcription), run:  mediascribe --help

Requires OPENROUTER_API_KEY (set in .env or the environment).
`

const program = new Command()
  .name('summary')
  .description('Summarize a PDF or Markdown file into a nicely formatted Markdown конспект (via OpenRouter)')
  .argument('[path]', 'Path to a .pdf/.md/.txt file, or a folder (uses its joined "Raw - ...md"); omit to show help')
  .option('-o, --output <path>', 'Output markdown file (default: "Summary - <name>.md" next to input)')
  .option('--model <slug>', 'OpenRouter model slug', SUMMARY_DEFAULT_MODEL)
  .option('--max-tokens <n>', 'Max output tokens', (v) => parseInt(v, 10), SUMMARY_MAX_OUTPUT_TOKENS)
  .option('--system <text|@file>', 'Override system prompt (literal text, or @path to read from a file)')
  .option('--prompt <text|@file>', 'Override summary prompt (literal text, or @path to read from a file)')
  .option('--dry', 'Show extracted size and cost estimate without calling the API', false)
  .option('--no-copy', 'Do not copy the result to the clipboard (wl-copy)')
  .addHelpText('after', HELP_AFTER)
  .action(async (input: string | undefined, opts: SummaryCliOptions) => {
    if (!input || input === 'help') {
      program.help()
      return
    }
    const rawInput = resolve(input)
    if (!(await fileExists(rawInput))) {
      console.error(`Error: path not found: ${rawInput}`)
      process.exit(1)
    }

    // A folder resolves to its already-joined "Raw - ...md" file.
    const inputPath = await resolveInputFile(rawInput)

    if (opts.dry) {
      await runDry(inputPath, opts)
      return
    }

    // Re-running overwrites the previous summary for the same input (idempotent, like the
    // mediascribe --summary pipeline). Use -o to write elsewhere.
    const outputPath = opts.output ? resolve(opts.output) : defaultOutputPath(inputPath)

    const systemPrompt = await resolvePromptArg(opts.system)
    const userPrompt = await resolvePromptArg(opts.prompt)

    console.log(`\n  ${basename(inputPath)} → ${basename(outputPath)}`)
    const t = performance.now()
    const result = await summarizeFile(inputPath, {
      model: opts.model,
      maxTokens: opts.maxTokens,
      systemPrompt,
      userPrompt,
    })

    const body = buildSummaryDocument(inputPath, result)
    await writeFile(outputPath, body, 'utf-8')

    const copied = opts.copy ? await copyToClipboard(body) : false

    const elapsed = ((performance.now() - t) / 1000).toFixed(1)
    console.log(`\n${'─'.repeat(50)}`)
    console.log(`Done in ${elapsed}s → ${outputPath}${copied ? ' (copied to clipboard)' : ''}`)
  })

program.parseAsync().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
