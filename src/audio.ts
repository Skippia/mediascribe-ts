import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function getDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ])
    const duration = parseFloat(stdout.trim())
    return Number.isFinite(duration) ? duration : null
  } catch {
    return null
  }
}

export async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

export async function compressAudio(inputPath: string, outputPath: string): Promise<void> {
  try {
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-vn',
      '-acodec', 'libmp3lame',
      '-b:a', '32k',
      '-ac', '1',
      '-ar', '16000',
      '-y',
      outputPath,
    ])
  } catch (err) {
    throw new Error(`Failed to compress audio: ${inputPath}`)
  }
}
