import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'

/** True if the path exists and is accessible. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Copy text to the Wayland clipboard via wl-copy. Non-fatal: warns and returns false on failure. */
export function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn('wl-copy', { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', (e: NodeJS.ErrnoException) => {
      process.stderr.write(
        e.code === 'ENOENT'
          ? '  (clipboard skipped: wl-copy not found — install wl-clipboard)\n'
          : `  (clipboard skipped: ${e.message})\n`,
      )
      resolvePromise(false)
    })
    child.on('exit', (code) => resolvePromise(code === 0))
    child.stdin.end(text, 'utf-8')
  })
}
