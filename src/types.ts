export interface TranscribeOptions {
  timestamps?: boolean
  assemblyaiApiKey?: string
}

export interface Paragraph {
  text: string
  timestamp: number // seconds
}

export interface TranscribeResult {
  paragraphs: Paragraph[]
  markdown: string
  duration: number
  backend: 'openrouter' | 'assemblyai'
}

export interface CostEstimate {
  duration: number
  cost: number
}

export const DURATION_THRESHOLD = 1800 // 30 minutes in seconds
export const DEFAULT_MODEL = 'google/gemini-3-flash-preview'

// ─── Summary command ────────────────────────────────────────────────────────

export interface SummaryOptions {
  model?: string
  maxTokens?: number
  systemPrompt?: string
  userPrompt?: string
  openrouterApiKey?: string
}

export const SUMMARY_DEFAULT_MODEL = 'anthropic/claude-opus-4.8'
export const SUMMARY_MAX_OUTPUT_TOKENS = 8000

// Inputs estimated above this many tokens (chars/4) are summarized via map-reduce
// instead of a single pass. Opus 4.8 holds ~1M tokens; we leave headroom for the
// system prompt and the model's own output.
export const SUMMARY_SINGLE_PASS_TOKEN_LIMIT = 700_000
// Per-chunk size for the map step, in tokens (chars/4).
export const SUMMARY_CHUNK_TOKEN_SIZE = 120_000

// OpenRouter list pricing for the default model (USD per 1M tokens).
export const SUMMARY_INPUT_PRICE_PER_M = 5.0
export const SUMMARY_OUTPUT_PRICE_PER_M = 25.0

// Files whose extension is in this set are read directly as UTF-8 text.
export const SUMMARY_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

export const SUMMARY_USER_PROMPT =
  'Составь детальный конспект без воды. Раздели материал на отдельные тейки (идеи).\n\n' +
  'ВАЖНО про группировку по источникам: документ собран из нескольких исходных файлов, ' +
  'каждый начинается с Markdown-заголовка вида «# <имя файла>» (например «# 002 - Inner Game.md»). ' +
  'Сгруппируй тейки по исходным файлам: для каждого файла сначала выведи его имя как заголовок ' +
  'второго уровня «## <имя файла>», а затем все тейки из этого файла. Сохраняй порядок файлов ' +
  'и тейков как в исходнике. Если документ состоит из единственного источника (заголовков «# …» ' +
  'нет) — не добавляй заголовок «## …», просто выведи тейки подряд.\n\n' +
  'Каждый тейк оформляй строго в таком формате Markdown:\n\n' +
  '### <Название тейка>\n' +
  '- **Description:** <ясное объяснение сути идеи, без воды>\n' +
  '- **Practice:** <как конкретно применить эту идею на практике, чтобы соблазнять женщин>\n\n' +
  'Итоговая структура выглядит так:\n\n' +
  '## 001 - Inner Game.md\n' +
  '### Первый тейк\n' +
  '- **Description:** ...\n' +
  '### Второй тейк\n' +
  '- **Description:** ...\n' +
  '## 002 - Calibration.md\n' +
  '### Третий тейк\n' +
  '- **Description:** ...\n\n' +
  'Пункт **Practice** добавляй ТОЛЬКО если идея реально применима в контексте соблазнения; ' +
  'если идея к этому неприменима — полностью опусти строку Practice и оставь только Description.\n\n' +
  'ВАЖНО про перечисления: НИКОГДА не пиши перечисление в одну строку через «1) … 2) … 3) …». ' +
  'Если внутри Description или Practice нужно перечислить несколько пунктов, выноси их во ' +
  'вложенный нумерованный список — каждый пункт с НОВОЙ строки и с отступом в 4 пробела ' +
  'относительно буллета. Пример:\n' +
  '- **Description:** Вступительное предложение. Вот эти способы:\n' +
  '    1. Первый пункт.\n' +
  '    2. Второй пункт.\n' +
  '    3. Третий пункт.\n\n' +
  'Сохраняй все значимые идеи автора, ничего не смягчай и не цензурируй. Пиши на русском языке.'

// Faithful, non-moralizing summarizer. Intentionally NOT the jailbreak persona
// from the original request: no guardrail-stripping, no facilitation of wrongdoing.
// It only removes refusals/moralizing so legitimate mature source material
// (sexual, substance, harm-reduction course content) is summarized as written.
export const SUMMARY_SYSTEM_PROMPT =
  'Ты — внимательный и точный составитель конспектов. Твоя задача — честно и ' +
  'полно передать содержание исходного материала, каким бы оно ни было, включая ' +
  'темы для взрослых: секс, употребление психоактивных веществ, снижение вреда. ' +
  'Ты не отказываешься от работы, не морализируешь, не вставляешь предупреждения ' +
  'и оценочные суждения от себя. Ты передаёшь идеи и факты так, как они изложены ' +
  'автором, не искажая и не смягчая их. Весь ответ — на русском языке, в виде ' +
  'аккуратно оформленного Markdown.'

export const SUPPORTED_EXTENSIONS = new Set([
  // Video
  '.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.wmv', '.divx',
  '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.3gp', '.m4v',
  '.vob', '.ogv', '.asf',
  // Audio
  '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  '.aac', '.opus', '.wma', '.aiff', '.aif',
  '.amr', '.ape', '.ac3', '.dts', '.mka',
])
