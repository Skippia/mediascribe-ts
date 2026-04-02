import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

const YT_URL_PATTERN = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//

export function isYouTubeUrl(input: string): boolean {
  return YT_URL_PATTERN.test(input)
}

export interface YouTubeInfo {
  title: string
  channel: string
  duration: number
  videoId: string
}

export async function getYouTubeInfo(url: string): Promise<YouTubeInfo> {
  const { stdout } = await execFileAsync('yt-dlp', [
    '--dump-json', '--no-download', url,
  ], { maxBuffer: 10 * 1024 * 1024 })
  const data = JSON.parse(stdout)
  return {
    title: data.title ?? 'Untitled',
    channel: data.channel ?? data.uploader ?? '',
    duration: data.duration ?? 0,
    videoId: data.id ?? '',
  }
}

export async function downloadAudio(url: string): Promise<{ audioPath: string; cleanup: () => Promise<void> }> {
  const audioPath = join(tmpdir(), `mediascribe-yt-${randomUUID()}.mp3`)

  await execFileAsync('yt-dlp', [
    '-x', '--audio-format', 'mp3',
    '--audio-quality', '0',
    '-o', audioPath,
    url,
  ], { maxBuffer: 10 * 1024 * 1024 })

  return {
    audioPath,
    cleanup: () => unlink(audioPath).catch(() => {}),
  }
}
