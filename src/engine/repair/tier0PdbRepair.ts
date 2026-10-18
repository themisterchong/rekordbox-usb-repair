/**
 * Tier 0 cross-format reconciliation orchestration for `export.pdb` - plan
 * §3, extended to cover every table we have validated read+write support
 * for (not just tracks - see the stress-test findings that motivated
 * this). Ties together: backup (twice, before touching anything) ->
 * extract recovery data from a healthy exportLibrary.db (via the isolated
 * worker, see sqlCipherRecovery.ts) -> repair every reconcilable table's
 * truncated chain -> backfill missing tracks, lookup rows, playlists, and
 * playlist entries (pdbEditor.ts) -> write to a temp path -> verify
 * structurally -> atomic swap into the real path, or stop if verification
 * fails.
 *
 * Deliberately limited to tables with a *validated* writer in
 * pdbEditor.ts (ported from fragmede/rekordbox-pdb's actual tested write
 * paths): tracks, genres, artists, albums, labels, keys, playlist_tree,
 * playlist_entries. Colors, artwork, columns, and the history tables have
 * no writer yet - guessing at their binary layout rather than working
 * from a validated reference is exactly the risk this project has been
 * careful to avoid throughout. Corruption in those tables is detected
 * (surfaced via checkHealth) but not yet repaired.
 *
 * Deliberately takes explicit file/dir paths rather than doing its own
 * drive scanning - stays composable and testable independent of the
 * Electron-specific parts (drive detection, app data dir) that the main
 * process supplies.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { Database, TableType } from '../pdb/pdbReader'
import { PdbEditor } from '../pdb/pdbEditor'
import { extractFullLibrary } from '../sqlcipher/sqlCipherRecovery'

/**
 * The IPC-facing request shape (what the renderer sends) - deliberately
 * narrower than Tier0RepairOptions, which also needs the backup
 * directories main/ipc.ts computes from Electron's app.getPath(). Defined
 * here rather than in main/ so preload can safely import it (preload only
 * ever imports from engine/, never main/ - same layering rule as
 * sqlCipherRecovery.ts's ContentRecord).
 */
export interface Tier0RepairRequest {
  rekordboxDir: string
  volumeName: string
  corruptedPdbPath: string
  healthyOneLibraryPath: string
}

export interface Tier0RepairOptions {
  /** Absolute path to the corrupted export.pdb on the drive. */
  corruptedPdbPath: string
  /** Absolute path to the healthy exportLibrary.db on the same drive. */
  healthyOneLibraryPath: string
  /** Directory on the USB itself to back the original up into. */
  usbBackupDir: string
  /** Directory on the local Mac to back the original up into. */
  localBackupDir: string
  /** Used to name the local backup file distinctly per drive. */
  driveLabel: string
}

export interface Tier0RepairResult {
  usbBackupPath: string
  localBackupPath: string
  tracksBefore: number
  tracksRecovered: number
  tracksAfter: number
  genresRecovered: number
  artistsRecovered: number
  albumsRecovered: number
  labelsRecovered: number
  keysRecovered: number
  playlistsRecovered: number
  playlistEntriesRecovered: number
  verified: boolean
  /** Set only once the verified repair has actually been swapped into place. */
  appliedPath: string | null
  notes: string[]
}

/** Tables with a validated writer in pdbEditor.ts - see the module doc for why this list stops here. */
const RECONCILABLE_TABLES = [
  TableType.TRACKS,
  TableType.GENRES,
  TableType.ARTISTS,
  TableType.ALBUMS,
  TableType.LABELS,
  TableType.KEYS,
  TableType.PLAYLIST_TREE,
  TableType.PLAYLIST_ENTRIES
]

/** Exported for standaloneSalvage.ts, which follows the exact same backup-
 * then-verify sequence for a different repair path - no reason for these
 * to diverge into two copies. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Copies `data` to `destPath`, then reads it back and checksums it against
 * `data` to confirm the copy is genuinely byte-identical - a backup that
 * silently failed to write correctly is worse than no backup at all. */
export function backupWithVerification(data: Buffer, destDir: string, destName: string): string {
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, destName)
  writeFileSync(destPath, data)
  const readBack = readFileSync(destPath)
  if (sha256(readBack) !== sha256(data)) {
    throw new Error(`backup verification failed: ${destPath} does not match the original byte-for-byte`)
  }
  return destPath
}

export async function repairPdbViaTier0(opts: Tier0RepairOptions): Promise<Tier0RepairResult> {
  const notes: string[] = []
  const originalBytes = readFileSync(opts.corruptedPdbPath)
  const originalHash = sha256(originalBytes)
  const ts = timestamp()
  const label = sanitizeLabel(opts.driveLabel)

  // Step 1: back up the corrupted original, twice, before touching
  // anything - never let the only backup live on the same drive that
  // might be developing a hardware fault.
  const usbBackupPath = backupWithVerification(originalBytes, opts.usbBackupDir, `export_corrupted_${ts}.pdb`)
  const localBackupPath = backupWithVerification(originalBytes, opts.localBackupDir, `${label}_${ts}.pdb`)
  notes.push(`Backed up original (verified byte-identical) to ${usbBackupPath} and ${localBackupPath}`)

  // Re-read the source from disk fresh (not the in-memory originalBytes)
  // to guarantee we're about to operate on exactly what we just backed up.
  const sourceForRepair = readFileSync(opts.corruptedPdbPath)
  if (sha256(sourceForRepair) !== originalHash) {
    throw new Error('corrupted pdb changed on disk between backup and repair - aborting, nothing further touched')
  }

  // Everything past this point (reconciliation, writing, verifying) is
  // wrapped so that ANY unexpected failure - not just the ones we've
  // already anticipated (see repairTruncatedChain's unrecoverable flag) -
  // becomes a clean "couldn't repair this" result instead of an unhandled
  // crash. Caught via stress-testing: a destroyed table directory (real
  // structural corruption, needing page-scan salvage we haven't built
  // yet) throws deep inside PdbEditor rather than returning a tidy
  // failure. The atomic swap only ever happens after an explicit
  // `verified === true` further down, so nothing here risks touching the
  // original even if this whole block throws.
  try {
    return await reconcileAndApply(opts, sourceForRepair, usbBackupPath, localBackupPath, notes)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    notes.push(`Repair could not proceed: ${message} - nothing was applied, your drive is untouched`)
    return {
      usbBackupPath,
      localBackupPath,
      tracksBefore: 0,
      tracksRecovered: 0,
      tracksAfter: 0,
      genresRecovered: 0,
      artistsRecovered: 0,
      albumsRecovered: 0,
      labelsRecovered: 0,
      keysRecovered: 0,
      playlistsRecovered: 0,
      playlistEntriesRecovered: 0,
      verified: false,
      appliedPath: null,
      notes
    }
  }
}

async function reconcileAndApply(
  opts: Tier0RepairOptions,
  sourceForRepair: Buffer,
  usbBackupPath: string,
  localBackupPath: string,
  notes: string[]
): Promise<Tier0RepairResult> {
  const before = new Database(sourceForRepair)
  const tracksBefore = before.tracks.length
  const pdbTrackPaths = new Set(before.tracks.map((t) => t.filePath))
  const playlistEntriesBefore = before.playlistEntries.length
  const playlistTreeBefore = before.playlistTree.length

  // Step 2: extract everything needed for full reconciliation, via the
  // isolated worker (never opens SQLite in this process - sqlCipherRecovery.ts).
  const lib = await extractFullLibrary(opts.healthyOneLibraryPath)

  const editor = new PdbEditor(sourceForRepair)

  // Step 3: reconnect every reconcilable table's chain up front, before
  // any appends - each is independently truncated-or-not.
  const unrecoverableTables: number[] = []
  for (const t of RECONCILABLE_TABLES) {
    const r = editor.repairTruncatedChain(t)
    if (r.unrecoverable) {
      // The table's own first page didn't survive at all - nothing to
      // reconnect a new page to. Real salvage (Tier 1) would be needed,
      // not a chain repair; skip appending to this table entirely rather
      // than let a downstream append crash against a directory entry
      // pointing nowhere valid.
      unrecoverableTables.push(t)
      notes.push(`${TableType[t]} lost entirely (no surviving pages) - cannot recover via cross-format reconciliation alone`)
    } else if (r.repaired) {
      notes.push(`Reconnected ${TableType[t]}'s chain at page ${r.lastGoodPage} (${r.rowsBeforeCut} rows were already intact there)`)
    }
  }
  // addTrack (and the lookup-table parity passes) can transitively touch
  // any of these tables - guard on all of them being writable rather than
  // track precise per-call dependencies, so an unrecoverable table never
  // reaches a crash, only a clearly-reported skip.
  const trackDependentTables = [
    TableType.TRACKS,
    TableType.GENRES,
    TableType.ARTISTS,
    TableType.ALBUMS,
    TableType.LABELS,
    TableType.KEYS
  ]
  const canRecoverTracksAndLookups = trackDependentTables.every((t) => !unrecoverableTables.includes(t))

  // Step 4: missing tracks, by file path (the only reliable cross-format key - ids diverge).
  const missingTracks = lib.tracks.filter((row) => !pdbTrackPaths.has(row.path))
  let tracksRecovered = 0
  const trackFailures: string[] = []
  if (!canRecoverTracksAndLookups) {
    notes.push('Skipped track/genre/artist/album/label/key recovery - one of those tables has no surviving pages at all')
  } else {
    for (const row of missingTracks) {
      try {
        editor.addTrack(row.title, row.path, {
          filename: row.fileName,
          artist: row.artistName ?? undefined,
          album: row.albumName ?? undefined,
          genre: row.genreName ?? undefined,
          key: row.keyName ?? undefined,
          label: row.labelName ?? undefined,
          tempo: row.bpmx100,
          duration: row.length,
          year: row.releaseYear,
          bitrate: row.bitrate,
          sampleRate: row.samplingRate,
          sampleDepth: row.bitDepth,
          fileSize: row.fileSize,
          trackNumber: row.trackNo,
          discNumber: row.discNo,
          rating: row.rating,
          playCount: row.djPlayCount
        })
        tracksRecovered++
      } catch (err) {
        trackFailures.push(`${row.path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (trackFailures.length) {
    notes.push(`${trackFailures.length} track(s) could not be recovered: ${trackFailures.slice(0, 5).join('; ')}${trackFailures.length > 5 ? '...' : ''}`)
  }

  // Step 5: full-parity pass on the simple lookup tables - orphaned
  // entries not tied to any recovered track (matches getOrCreate's own
  // name-only matching, same as the reference implementation - it
  // doesn't disambiguate e.g. same-named albums by different artists
  // either, a known limitation carried over intentionally rather than
  // inventing unvalidated matching logic of our own).
  let genresRecovered = 0
  let artistsRecovered = 0
  let labelsRecovered = 0
  let keysRecovered = 0
  let albumsRecovered = 0
  if (canRecoverTracksAndLookups) {
    const existingGenres = new Set(editor.db.genres.map((g) => g.name))
    for (const name of lib.genres) {
      if (!existingGenres.has(name)) {
        editor.getOrCreateGenre(name)
        existingGenres.add(name)
        genresRecovered++
      }
    }

    const existingArtists = new Set(editor.db.artists.map((a) => a.name))
    for (const name of lib.artists) {
      if (!existingArtists.has(name)) {
        editor.getOrCreateArtist(name)
        existingArtists.add(name)
        artistsRecovered++
      }
    }

    const existingLabels = new Set(editor.db.labels.map((l) => l.name))
    for (const name of lib.labels) {
      if (!existingLabels.has(name)) {
        editor.getOrCreateLabel(name)
        existingLabels.add(name)
        labelsRecovered++
      }
    }

    const existingKeys = new Set(editor.db.keys.map((k) => k.name))
    for (const name of lib.keys) {
      if (!existingKeys.has(name)) {
        editor.getOrCreateKey(name)
        existingKeys.add(name)
        keysRecovered++
      }
    }

    const existingAlbums = new Set(editor.db.albums.map((a) => a.name))
    for (const row of lib.albums) {
      if (!existingAlbums.has(row.name)) {
        const artistId = row.artistName ? editor.getOrCreateArtist(row.artistName) : 0
        editor.getOrCreateAlbum(row.name, artistId)
        existingAlbums.add(row.name)
        albumsRecovered++
      }
    }
  }

  // Step 6: playlists - iterative resolution so parent-before-child order
  // doesn't have to match exportLibrary's own id ordering.
  const oneLibIdToPdbId = new Map<number, number>([[0, 0]]) // 0 = root, both formats
  const existingPlaylistsByNameParent = new Map<string, number>()
  for (const p of editor.db.playlistTree) {
    existingPlaylistsByNameParent.set(`${p.name} ${p.parentId}`, p.id)
  }

  let playlistsRecovered = 0
  let remaining = [...lib.playlists]
  const playlistTreeWritable = !unrecoverableTables.includes(TableType.PLAYLIST_TREE)
  if (!playlistTreeWritable) {
    notes.push('Skipped playlist recovery - PLAYLIST_TREE has no surviving pages at all')
  }
  let progressed = playlistTreeWritable
  while (remaining.length && progressed) {
    progressed = false
    const stillRemaining: typeof remaining = []
    for (const p of remaining) {
      const pdbParentId = oneLibIdToPdbId.get(p.parentId)
      if (pdbParentId === undefined) {
        stillRemaining.push(p)
        continue
      }
      const key = `${p.name} ${pdbParentId}`
      let pdbId = existingPlaylistsByNameParent.get(key)
      if (pdbId === undefined) {
        pdbId = editor.createPlaylist(p.name, pdbParentId, p.isFolder)
        existingPlaylistsByNameParent.set(key, pdbId)
        playlistsRecovered++
      }
      oneLibIdToPdbId.set(p.id, pdbId)
      progressed = true
    }
    remaining = stillRemaining
  }
  if (remaining.length) {
    notes.push(`${remaining.length} playlist(s) could not be placed (broken parent chain): ${remaining.map((p) => p.name).join(', ')}`)
  }

  // Step 7: playlist entries - resolve both sides by content, not id
  // (track ids and playlist ids are both format-local, never shared).
  let playlistEntriesRecovered = 0
  let unresolvedEntries = 0
  const entryFailures: string[] = []
  const playlistEntriesWritable = !unrecoverableTables.includes(TableType.PLAYLIST_ENTRIES)
  if (!playlistEntriesWritable) {
    notes.push('Skipped playlist-entry recovery - PLAYLIST_ENTRIES has no surviving pages at all')
  } else {
    const pathToPdbTrackId = new Map(editor.db.tracks.map((t) => [t.filePath, t.id]))
    const existingEntries = new Set(editor.db.playlistEntries.map((e) => `${e.playlistId} ${e.trackId}`))
    for (const row of lib.playlistContent) {
      const pdbPlaylistId = oneLibIdToPdbId.get(row.playlistId)
      const pdbTrackId = pathToPdbTrackId.get(row.trackPath)
      if (pdbPlaylistId === undefined || pdbTrackId === undefined) {
        unresolvedEntries++
        continue
      }
      const key = `${pdbPlaylistId} ${pdbTrackId}`
      if (existingEntries.has(key)) continue
      try {
        editor.addToPlaylist(pdbPlaylistId, pdbTrackId)
        existingEntries.add(key)
        playlistEntriesRecovered++
      } catch (err) {
        entryFailures.push(err instanceof Error ? err.message : String(err))
      }
    }
  }
  if (unresolvedEntries) {
    notes.push(`${unresolvedEntries} playlist entry/entries could not be matched to a recovered track or playlist`)
  }
  if (entryFailures.length) {
    notes.push(`${entryFailures.length} playlist entry/entries failed to add: ${entryFailures.slice(0, 5).join('; ')}`)
  }

  // Step 8: write to a temp path - never the canonical filename yet.
  const outBytes = editor.toBytes()
  const tempPath = `${opts.corruptedPdbPath}.repairing-tmp`
  writeFileSync(tempPath, outBytes)

  // Step 9: verify structurally, independently re-parsing the temp file
  // exactly as a fresh repair-check would.
  const after = new Database(readFileSync(tempPath))
  const remainingErrors = RECONCILABLE_TABLES.map((t) => after.tableErrors.get(t)).filter((e): e is string => !!e)

  const beforeById = new Map(before.tracks.map((t) => [t.id, t]))
  let unchangedTracks = 0
  for (const t of after.tracks) {
    const orig = beforeById.get(t.id)
    if (orig && JSON.stringify(orig) === JSON.stringify(t)) unchangedTracks++
  }
  const allOriginalTracksPreserved = unchangedTracks === tracksBefore
  const afterPaths = new Set(after.tracks.map((t) => t.filePath))
  const stillMissingTracks = missingTracks.filter((row) => !afterPaths.has(row.path))

  // Weaker but still meaningful invariant for playlists (row shapes vary
  // more than tracks, exact unchanged-row comparison is less practical
  // here): nothing should ever shrink.
  const playlistsNotLost = after.playlistTree.length >= playlistTreeBefore
  const playlistEntriesNotLost = after.playlistEntries.length >= playlistEntriesBefore

  const verified =
    remainingErrors.length === 0 &&
    allOriginalTracksPreserved &&
    stillMissingTracks.length === 0 &&
    trackFailures.length === 0 &&
    remaining.length === 0 &&
    entryFailures.length === 0 &&
    playlistsNotLost &&
    playlistEntriesNotLost

  const summary = {
    usbBackupPath,
    localBackupPath,
    tracksBefore,
    tracksRecovered,
    tracksAfter: after.tracks.length,
    genresRecovered,
    artistsRecovered,
    albumsRecovered,
    labelsRecovered,
    keysRecovered,
    playlistsRecovered,
    playlistEntriesRecovered
  }

  if (!verified) {
    notes.push(
      `Verification FAILED - nothing was applied. remainingTableErrors=${remainingErrors.length}, ` +
        `originalTracksPreserved=${unchangedTracks}/${tracksBefore}, stillMissingTracks=${stillMissingTracks.length}, ` +
        `unplacedPlaylists=${remaining.length}`
    )
    return { ...summary, verified: false, appliedPath: null, notes }
  }

  // Step 10: only now, atomically swap the verified file into place.
  // Same-volume rename is atomic on both APFS and exFAT - this can't
  // produce the kind of half-written file that caused the original
  // corruption.
  renameSync(tempPath, opts.corruptedPdbPath)
  notes.push(
    `Verified and applied: ${opts.corruptedPdbPath} now has ${after.tracks.length} tracks, ${after.playlistTree.length} playlists, ${after.playlistEntries.length} playlist entries`
  )

  return { ...summary, verified: true, appliedPath: opts.corruptedPdbPath, notes }
}
