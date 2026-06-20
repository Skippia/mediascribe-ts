import { execFile, spawn } from 'node:child_process'
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
    '--no-playlist',
    '-o', audioPath,
    url,
  ], { maxBuffer: 10 * 1024 * 1024 })

  return {
    audioPath,
    cleanup: () => unlink(audioPath).catch(() => {}),
  }
}

/** Run yt-dlp with inherited stdio so the user sees download progress; rejects on non-zero exit. */
function runYtDlp(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn('yt-dlp', args, { stdio: 'inherit' })
    child.on('error', (err: NodeJS.ErrnoException) => {
      rej(err.code === 'ENOENT' ? new Error('yt-dlp not found in PATH') : err)
    })
    child.on('exit', (code) => {
      if (code === 0) res()
      else rej(new Error(`yt-dlp exited with code ${code}`))
    })
  })
}

/** Shared yt-dlp args: best video+audio, merged into a single mp4. */
const VIDEO_FORMAT_ARGS = ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4']

/** yt-dlp args for audio-only extraction (used for transient transcription when the video isn't kept). */
const AUDIO_FORMAT_ARGS = ['-x', '--audio-format', 'mp3', '--audio-quality', '0']

/** Full video (kept) vs audio-only (transient) download args. */
function formatArgs(keep: boolean): string[] {
  return keep ? VIDEO_FORMAT_ARGS : AUDIO_FORMAT_ARGS
}

/**
 * A dedicated playlist page (youtube.com/playlist?list=...) is treated as a playlist.
 * A watch?v=...&list=... URL is treated as a single video (we download just that one).
 */
export function isYouTubePlaylistUrl(input: string): boolean {
  if (!isYouTubeUrl(input)) return false
  try {
    const u = new URL(input)
    return u.pathname.replace(/\/+$/, '') === '/playlist' && u.searchParams.has('list')
  } catch {
    return false
  }
}

export interface PlaylistEntry {
  duration: number | null
}

export interface PlaylistInfo {
  title: string
  entries: PlaylistEntry[]
}

export async function getPlaylistInfo(url: string): Promise<PlaylistInfo> {
  const { stdout } = await execFileAsync('yt-dlp', [
    '--flat-playlist', '--dump-single-json', '--no-warnings', url,
  ], { maxBuffer: 64 * 1024 * 1024 })
  const data = JSON.parse(stdout) as {
    title?: string
    id?: string
    entries?: Array<{ duration?: number }>
  }
  const entries: PlaylistEntry[] = (data.entries ?? []).map((e) => ({
    duration: typeof e.duration === 'number' ? e.duration : null,
  }))
  return { title: data.title ?? data.id ?? 'Playlist', entries }
}

/**
 * Download a single video as `<destStem>.mp4` (best video+audio, merged to mp4).
 * `destStem` is an absolute path without extension. Returns the final mp4 path.
 */
export async function downloadVideo(url: string, destStem: string): Promise<string> {
  await runYtDlp([...VIDEO_FORMAT_ARGS, '--no-playlist', '-o', `${destStem}.%(ext)s`, url])
  return `${destStem}.mp4`
}

/** Download every item of a playlist into `destDir` as "NN. <title>.<ext>". Full video when keep, else audio-only. */
export async function downloadPlaylist(url: string, destDir: string, keep: boolean): Promise<void> {
  await runYtDlp([
    ...formatArgs(keep),
    '--yes-playlist',
    '--ignore-errors', // skip private/unavailable videos instead of aborting the whole playlist
    '-o', join(destDir, '%(playlist_index)02d. %(title)s.%(ext)s'),
    url,
  ])
}

const YT_URL_GLOBAL = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s)"'<>\]]+/g

/** Extract all YouTube URLs from arbitrary text (e.g. a markdown file), deduped, order-preserved. */
export function extractYouTubeUrls(text: string): string[] {
  const matches = text.match(YT_URL_GLOBAL) ?? []
  const seen = new Set<string>()
  const urls: string[] = []
  for (const raw of matches) {
    const url = raw.replace(/[.,;]+$/, '') // drop trailing sentence punctuation
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

/** Download a single item into `destDir`, named by its title. Full video when keep, else audio-only. */
export async function downloadVideoInto(url: string, destDir: string, keep: boolean): Promise<void> {
  await runYtDlp([...formatArgs(keep), '--no-playlist', '-o', join(destDir, '%(title)s.%(ext)s'), url])
}

/** Download a whole playlist into `destDir/<playlist title>/NN. <title>.<ext>`. Full video when keep, else audio-only. */
export async function downloadPlaylistInto(url: string, destDir: string, keep: boolean): Promise<void> {
  await runYtDlp([
    ...formatArgs(keep),
    '--yes-playlist',
    '--ignore-errors', // skip private/unavailable videos instead of aborting the whole playlist
    '-o', join(destDir, '%(playlist_title)s/%(playlist_index)02d. %(title)s.%(ext)s'),
    url,
  ])
}
