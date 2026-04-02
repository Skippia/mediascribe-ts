import type { Paragraph } from './types.js'

export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${String(h).padStart(2, '0')}:${mm}:${ss}`
  return `${mm}:${ss}`
}

export function buildMarkdown(
  inputName: string,
  paragraphs: Paragraph[],
  options: { timestamps?: boolean; duration: number; backend: string },
): string {
  const lines: string[] = [
    `# Transcription: ${inputName}`,
    '',
    `- **Duration:** ${formatTimestamp(options.duration)}`,
    `- **Backend:** ${options.backend}`,
    '',
    '## Content',
    '',
  ]

  for (const { text, timestamp } of paragraphs) {
    if (options.timestamps) {
      lines.push(`**[${formatTimestamp(timestamp)}]** ${text}`, '')
    } else {
      lines.push(text, '')
    }
  }

  return lines.join('\n')
}
