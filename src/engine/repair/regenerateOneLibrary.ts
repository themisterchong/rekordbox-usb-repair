/**
 * Regenerates `exportLibrary.db` from a healthy `export.pdb` - plan Phase
 * 2. Only ever call this once the pdb is confirmed healthy (either it
 * always was, or Tier 0 / standalone salvage just fixed it) - this module
 * has no salvage logic of its own, it only builds fresh from whatever the
 * pdb currently, correctly contains.
 *
 * Same backup-then-verify-then-atomic-swap sequence as the pdb repair
 * paths. Validated once against real Rekordbox software (2026-09-17,
 * real device, 1293 tracks/16 playlists - accepted and browsed
 * correctly) in addition to this project's own reader, but that's one
 * successful run, not exhaustive coverage - see oneLibrarySchema.ts and
 * buildOneLibrary.ts for what is and isn't populated (hot cues, history,
 * and My Tags are never recoverable this way, since they were never in
 * export.pdb to begin with).
 */
import { readFileSync, mkdirSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { Database } from '../pdb/pdbReader'
import { buildOneLibraryFromPdb } from '../sqlcipher/buildOneLibrary'
import { extractContentRecords } from '../sqlcipher/sqlCipherRecovery'
import { timestamp, sanitizeLabel, backupWithVerification } from './tier0PdbRepair'

export interface RegenerateOneLibraryRequest {
  rekordboxDir: string
  volumeName: string
  healthyPdbPath: string
}

export interface RegenerateOneLibraryOptions {
  healthyPdbPath: string
  targetPath: string
  /** Only set (and only backed up) if a file already exists there, however corrupted. */
  usbBackupDir: string
  localBackupDir: string
  driveLabel: string
}

export interface RegenerateOneLibraryResult {
  usbBackupPath: string | null
  localBackupPath: string | null
  tracksWritten: number
  genresWritten: number
  artistsWritten: number
  albumsWritten: number
  labelsWritten: number
  keysWritten: number
  playlistsWritten: number
  playlistEntriesWritten: number
  verified: boolean
  appliedPath: string | null
  notes: string[]
}

export async function regenerateOneLibraryFromPdb(opts: RegenerateOneLibraryOptions): Promise<RegenerateOneLibraryResult> {
  const notes: string[] = [
    'Tested successfully against real Rekordbox software on one real device - but that’s one run, not ' +
      'exhaustive coverage. Open Rekordbox’s Devices panel and check this drive before relying on it, and ' +
      'expect hot cues, history, and My Tags to be missing (they were never in export.pdb to begin with).'
  ]

  let usbBackupPath: string | null = null
  let localBackupPath: string | null = null
  if (existsSync(opts.targetPath)) {
    const originalBytes = readFileSync(opts.targetPath)
    usbBackupPath = backupWithVerification(originalBytes, opts.usbBackupDir, `exportLibrary_corrupted_${timestamp()}.db`)
    localBackupPath = backupWithVerification(
      originalBytes,
      opts.localBackupDir,
      `${sanitizeLabel(opts.driveLabel)}_exportLibrary_${timestamp()}.db`
    )
    notes.push(`Backed up the existing (corrupted) exportLibrary.db to ${usbBackupPath} and ${localBackupPath} before replacing it`)
  }

  const emptySummary = {
    tracksWritten: 0,
    genresWritten: 0,
    artistsWritten: 0,
    albumsWritten: 0,
    labelsWritten: 0,
    keysWritten: 0,
    playlistsWritten: 0,
    playlistEntriesWritten: 0
  }

  try {
    const pdb = new Database(readFileSync(opts.healthyPdbPath))
    if (pdb.tableErrors.size > 0) {
      throw new Error('export.pdb is not structurally healthy - fix it first, then rebuild exportLibrary.db from the fixed copy')
    }

    const tempPath = `${opts.targetPath}.rebuilding-tmp`
    const summary = await buildOneLibraryFromPdb(pdb, tempPath, opts.driveLabel)

    // Verify by reading it back through the SAME isolated extraction path
    // the rest of the app uses, not just trusting the writer succeeded.
    const readBack = await extractContentRecords(tempPath)
    const verified = readBack.length === summary.tracksWritten

    if (!verified) {
      notes.push(`Verification FAILED - nothing was applied. Wrote ${summary.tracksWritten} tracks, read back ${readBack.length}.`)
      return { usbBackupPath, localBackupPath, ...emptySummary, verified: false, appliedPath: null, notes }
    }

    mkdirSync(join(opts.targetPath, '..'), { recursive: true })
    renameSync(tempPath, opts.targetPath)
    notes.push(`Rebuilt and applied: ${opts.targetPath} now has ${summary.tracksWritten} tracks, ${summary.playlistsWritten} playlists.`)

    return { usbBackupPath, localBackupPath, ...summary, verified: true, appliedPath: opts.targetPath, notes }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    notes.push(`Rebuild could not proceed: ${message} - nothing was applied, your drive is untouched`)
    return { usbBackupPath, localBackupPath, ...emptySummary, verified: false, appliedPath: null, notes }
  }
}

