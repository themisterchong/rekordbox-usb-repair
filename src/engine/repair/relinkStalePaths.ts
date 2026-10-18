/**
 * Stale file-path relink - a different problem from binary corruption
 * (plan's relink research): tracks whose stored path no longer resolves
 * on disk, most commonly from restoring a backup onto a new machine or
 * moving a music folder. The export.pdb itself is structurally fine; the
 * paths it holds are just wrong.
 *
 * Matching is filename, then filesize as a tiebreaker on collision -
 * deliberately NOT reproducing native Rekordbox's own documented bug of
 * silently picking the first filename match. Anything still ambiguous
 * after that is reported, never guessed. No audio fingerprinting in this
 * pass (Rekordbox's schema has no hash column at all; adding one is a
 * real scope increase - bundling fpcalc, decoding audio - left for later).
 *
 * Same safety sequence as Tier 0: backup twice (verified) -> resolve ->
 * patch in place -> write to temp -> verify -> atomic swap, or stop.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename } from 'path'
import { Database } from '../pdb/pdbReader'
import { PdbEditor } from '../pdb/pdbEditor'
import { buildFileIndex, type FileIndex } from '../relink/buildFileIndex'

/** The IPC-facing request shape - see Tier0RepairRequest for why this lives here, not in main/. */
export interface RelinkRequest {
  rekordboxDir: string
  volumeName: string
  volumePath: string
  pdbPath: string
}

export interface RelinkStalePathsOptions {
  /** Absolute path to the export.pdb to relink (must already be structurally healthy - run Tier 0 first if not). */
  pdbPath: string
  /** Root to search for the actual audio files - normally the drive's own root. */
  searchRoot: string
  usbBackupDir: string
  localBackupDir: string
  driveLabel: string
}

export interface UnresolvedTrack {
  trackId: number
  storedPath: string
  reason: 'not-found' | 'ambiguous'
  /** Only set for 'ambiguous' - the candidates that couldn't be disambiguated. */
  candidates?: string[]
}

export interface RelinkStalePathsResult {
  usbBackupPath: string
  localBackupPath: string
  tracksChecked: number
  staleFound: number
  relinked: number
  unresolved: UnresolvedTrack[]
  verified: boolean
  appliedPath: string | null
  notes: string[]
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function backupWithVerification(data: Buffer, destDir: string, destName: string): string {
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, destName)
  writeFileSync(destPath, data)
  const readBack = readFileSync(destPath)
  if (sha256(readBack) !== sha256(data)) {
    throw new Error(`backup verification failed: ${destPath} does not match the original byte-for-byte`)
  }
  return destPath
}

/** Resolves one stale track against the file index. Never guesses on ambiguity. */
function resolveTrack(
  storedPath: string,
  fileSize: number,
  index: FileIndex
):
  | { kind: 'found'; path: string; filename: string }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; candidates: string[] } {
  const filename = basename(storedPath)
  const candidates = index.get(filename.toLowerCase())
  if (!candidates || candidates.length === 0) return { kind: 'not-found' }
  if (candidates.length === 1) return { kind: 'found', path: candidates[0]!.path, filename }

  // Collision on filename - disambiguate by exact file size (cheap, already known).
  const bySize = fileSize > 0 ? candidates.filter((c) => c.size === fileSize) : candidates
  if (bySize.length === 1) return { kind: 'found', path: bySize[0]!.path, filename }

  // Still ambiguous - report, never silently pick the first one (that's
  // the exact bug native Rekordbox's own "Relocate All" is documented to have).
  return { kind: 'ambiguous', candidates: (bySize.length ? bySize : candidates).map((c) => c.path) }
}

export async function relinkStalePathsInPdb(opts: RelinkStalePathsOptions): Promise<RelinkStalePathsResult> {
  const notes: string[] = []
  const originalBytes = readFileSync(opts.pdbPath)
  const originalHash = sha256(originalBytes)
  const ts = timestamp()
  const label = sanitizeLabel(opts.driveLabel)

  const usbBackupPath = backupWithVerification(originalBytes, opts.usbBackupDir, `export_prerelink_${ts}.pdb`)
  const localBackupPath = backupWithVerification(originalBytes, opts.localBackupDir, `${label}_prerelink_${ts}.pdb`)
  notes.push(`Backed up original (verified byte-identical) to ${usbBackupPath} and ${localBackupPath}`)

  try {
    const sourceForRepair = readFileSync(opts.pdbPath)
    if (sha256(sourceForRepair) !== originalHash) {
      throw new Error('pdb changed on disk between backup and relink - aborting, nothing further touched')
    }

    const before = new Database(sourceForRepair)
    const tracksChecked = before.tracks.length

    const stale = before.tracks.filter((t) => !existsSync(join(opts.searchRoot, t.filePath.replace(/^\//, ''))))
    notes.push(`${stale.length} of ${tracksChecked} tracks have a path that doesn't resolve on this drive`)

    if (stale.length === 0) {
      return {
        usbBackupPath,
        localBackupPath,
        tracksChecked,
        staleFound: 0,
        relinked: 0,
        unresolved: [],
        verified: true,
        appliedPath: null,
        notes: [...notes, 'Nothing to relink - all paths already resolve']
      }
    }

    const index = buildFileIndex(opts.searchRoot)

    const editor = new PdbEditor(sourceForRepair)
    let relinked = 0
    const unresolved: UnresolvedTrack[] = []

    for (const track of stale) {
      const result = resolveTrack(track.filePath, track.fileSize, index)
      if (result.kind === 'not-found') {
        unresolved.push({ trackId: track.id, storedPath: track.filePath, reason: 'not-found' })
        continue
      }
      if (result.kind === 'ambiguous') {
        unresolved.push({ trackId: track.id, storedPath: track.filePath, reason: 'ambiguous', candidates: result.candidates })
        continue
      }
      // Path stored in the pdb is relative to the drive root, e.g. "/Contents/...".
      const relativePath = '/' + result.path.slice(opts.searchRoot.length).replace(/^\/+/, '')
      const ok = editor.relinkTrackPath(track.id, result.filename, relativePath)
      if (ok) relinked++
      else {
        unresolved.push({
          trackId: track.id,
          storedPath: track.filePath,
          reason: 'ambiguous',
          candidates: [`match found but new path too long to patch in place: ${relativePath}`]
        })
      }
    }
    if (unresolved.length) {
      notes.push(`${unresolved.length} stale track(s) could not be relinked automatically - see unresolved list`)
    }

    const outBytes = editor.toBytes()
    const tempPath = `${opts.pdbPath}.relinking-tmp`
    writeFileSync(tempPath, outBytes)

    // Verify: every relinked track's new path must now actually resolve,
    // and nothing else about the file (row count, other tracks) changed.
    const after = new Database(readFileSync(tempPath))
    const stillBroken = after.tracks.filter((t) => !existsSync(join(opts.searchRoot, t.filePath.replace(/^\//, ''))))
    const expectedStillBroken = unresolved.length
    const rowCountUnchanged = after.tracks.length === tracksChecked

    const verified = rowCountUnchanged && stillBroken.length === expectedStillBroken

    if (!verified) {
      notes.push(
        `Verification FAILED - nothing was applied. rowCountUnchanged=${rowCountUnchanged}, stillBroken=${stillBroken.length}/expected=${expectedStillBroken}`
      )
      return {
        usbBackupPath,
        localBackupPath,
        tracksChecked,
        staleFound: stale.length,
        relinked,
        unresolved,
        verified: false,
        appliedPath: null,
        notes
      }
    }

    renameSync(tempPath, opts.pdbPath)
    notes.push(`Verified and applied: ${relinked} track(s) relinked, ${unresolved.length} still need manual attention`)

    return {
      usbBackupPath,
      localBackupPath,
      tracksChecked,
      staleFound: stale.length,
      relinked,
      unresolved,
      verified: true,
      appliedPath: opts.pdbPath,
      notes
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    notes.push(`Relink could not proceed: ${message} - nothing was applied, your drive is untouched`)
    return {
      usbBackupPath,
      localBackupPath,
      tracksChecked: 0,
      staleFound: 0,
      relinked: 0,
      unresolved: [],
      verified: false,
      appliedPath: null,
      notes
    }
  }
}
