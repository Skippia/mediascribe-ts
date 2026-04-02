export interface TranscribeOptions {
  timestamps?: boolean
  cloudModel?: string
  openrouterApiKey?: string
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
  backend: 'openrouter' | 'assemblyai'
  cost: number
}

export const DURATION_THRESHOLD = 5400 // 1.5 hours in seconds
export const DEFAULT_MODEL = 'google/gemini-3-flash-preview'

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
