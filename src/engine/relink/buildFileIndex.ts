/**
 * Stale file-path relink - scans a volume once for audio files, indexed by
 * filename, for matching broken track paths back to where the files
 * actually live now. Built once per run and reused across every track
 * (same caching principle as the planned track-relocator design), not
 * re-walked per file.
 *
 * Deliberately filename + filesize matching only (no audio fingerprinting
 * in this pass - Rekordbox's own schema has no hash/fingerprint column at
 * all, per research; adding one would mean bundling fpcalc and decoding
 * audio, a real scope increase). When that's not enough to disambiguate,
 * this reports the conflict rather than guessing - native Rekordbox's own
 * "Relocate All" is documented to silently pick the first match on a
 * filename collision, which is exactly the failure mode to avoid.
 */
import { readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.aiff', '.aif', '.wav', '.flac', '.m4a', '.ogg'])

export interface IndexedFile {
  path: string // absolute
  size: number
}

export type FileIndex = Map<string, IndexedFile[]> // lowercase filename -> candidates

export function buildFileIndex(rootDir: string): FileIndex {
  const index: FileIndex = new Map()

  function walk(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      // Skip our own repair-backup folders and Rekordbox's own internal dirs.
      if (name === 'rekordbox_repair_backup' || name === '.PIONEER' || name === 'PIONEER') continue
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!AUDIO_EXTENSIONS.has(extname(name).toLowerCase())) continue
      const key = name.toLowerCase()
      const list = index.get(key)
      const entry: IndexedFile = { path: full, size: stat.size }
      if (list) list.push(entry)
      else index.set(key, [entry])
    }
  }

  walk(rootDir)
  return index
}
