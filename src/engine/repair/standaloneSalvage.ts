/**
 * Standalone `export.pdb` salvage ("Tier 1") - for the two cases Tier 0
 * can't help with: no `exportLibrary.db` sibling exists at all (it's an
 * optional, newer format - plenty of real sticks never had one), or it's
 * also corrupted. No healthy reference is required, or used, at any point
 * here - everything comes from what physically survives in the pdb file
 * itself (pdbPageScanner.ts's page-type self-identification, independent
 * of the file's own, possibly-broken, table directory).
 *
 * Same safety sequence as Tier 0: backup twice (verified) -> scan+rebuild
 * -> write to a temp path -> verify structurally -> atomic swap, or stop.
 * Weaker guarantee than Tier 0 throughout: there's no independent source
 * to check the result against, only internal consistency and "never lose
 * data the original, broken file's own chain-walk had already found."
 *
 * Status (2026-10-18): the rebuilt pdb is accepted by desktop Rekordbox,
 * browses and plays on the XDJ-700 v1.15 and CDJ-2000NXS2 firmware in
 * emulation, and the aligned-strings output was confirmed on two real
 * XDJ-700s (chrisle/rbxport#483). The early "Device library is corrupted"
 * rejection was fixed in the index-page layout work (rounds 25+).
 */
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { Database, TableType } from '../pdb/pdbReader'
import { scanPdbPages } from '../pdb/pdbPageScanner'
import { rebuildPdbFromScan } from '../pdb/pdbRebuilder'
import { sha256, timestamp, sanitizeLabel, backupWithVerification } from './tier0PdbRepair'

export interface StandaloneSalvageRequest {
  rekordboxDir: string
  volumeName: string
  corruptedPdbPath: string
}

export interface StandaloneSalvageOptions {
  /** Absolute path to the corrupted export.pdb on the drive. */
  corruptedPdbPath: string
  /** Directory on the USB itself to back the original up into. */
  usbBackupDir: string
  /** Directory on the local Mac to back the original up into. */
  localBackupDir: string
  /** Used to name the local backup file distinctly per drive. */
  driveLabel: string
}

export interface StandaloneSalvageResult {
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
  /** Table types with no validated writer, whose surviving pages were relocated verbatim rather than reconstructed. */
  tablesCarriedOverRaw: string[]
  verified: boolean
  /** Set only once the verified salvage has actually been swapped into place. */
  appliedPath: string | null
  notes: string[]
}

/** Every table type this reader knows how to walk at all. */
const ALL_TABLE_TYPES = Object.values(TableType).filter((v): v is number => typeof v === 'number')

/**
 * Tables deliberately excluded from the "never regress below baseline"
 * floor - not because losing them is fine, but because a raw row-count
 * comparison against them is the wrong test:
 *
 * - GENRES/ARTISTS/ALBUMS/LABELS/KEYS are rebuilt via PdbEditor's own
 *   getOrCreate* methods, which dedup by NAME (same as Tier 0, and the
 *   real Rekordbox reference implementation it's ported from - a known,
 *   intentional limitation, not a bug: "doesn't disambiguate e.g.
 *   same-named albums by different artists either"). A raw chain-walk
 *   baseline counts every row including exact name duplicates, so a
 *   name-deduped rebuild will legitimately, correctly end up with fewer
 *   rows than that baseline. What matters - every surviving track still
 *   showing the right genre/artist/album/label/key NAME - is unaffected.
 * - PLAYLIST_ENTRIES drops exactly the entries whose track or playlist
 *   didn't itself survive salvage - already reported honestly via
 *   `unresolvedEntries` in the rebuild summary's notes. Comparing its raw
 *   count against baseline would just re-report the same, already-visible
 *   loss as a false verification failure.
 */
const EXCLUDED_FROM_REGRESSION_FLOOR = new Set<number>([
  TableType.GENRES,
  TableType.ARTISTS,
  TableType.ALBUMS,
  TableType.LABELS,
  TableType.KEYS,
  TableType.PLAYLIST_ENTRIES
])

export async function repairPdbViaStandaloneSalvage(opts: StandaloneSalvageOptions): Promise<StandaloneSalvageResult> {
  const notes: string[] = []
  const originalBytes = readFileSync(opts.corruptedPdbPath)
  const originalHash = sha256(originalBytes)
  const ts = timestamp()
  const label = sanitizeLabel(opts.driveLabel)

  // Step 1: back up the corrupted original, twice, before touching
  // anything - same as Tier 0, and just as important here: this is the
  // only source of truth, there's no healthy sibling to fall back on.
  const usbBackupPath = backupWithVerification(originalBytes, opts.usbBackupDir, `export_corrupted_${ts}.pdb`)
  const localBackupPath = backupWithVerification(originalBytes, opts.localBackupDir, `${label}_${ts}.pdb`)
  notes.push(`Backed up original (verified byte-identical) to ${usbBackupPath} and ${localBackupPath}`)

  const sourceForRepair = readFileSync(opts.corruptedPdbPath)
  if (sha256(sourceForRepair) !== originalHash) {
    throw new Error('corrupted pdb changed on disk between backup and repair - aborting, nothing further touched')
  }

  try {
    return await scanRebuildAndApply(opts, sourceForRepair, usbBackupPath, localBackupPath, notes)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    notes.push(`Salvage could not proceed: ${message} - nothing was applied, your drive is untouched`)
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
      tablesCarriedOverRaw: [],
      verified: false,
      appliedPath: null,
      notes
    }
  }
}

async function scanRebuildAndApply(
  opts: StandaloneSalvageOptions,
  sourceForRepair: Buffer,
  usbBackupPath: string,
  localBackupPath: string,
  notes: string[]
): Promise<StandaloneSalvageResult> {
  const before = new Database(sourceForRepair)
  const tracksBefore = before.tracks.length

  // Baseline per-table row counts from the ORIGINAL, broken chain-walk -
  // the regression floor below only holds tables to this bar where the
  // original walk didn't already report an error for them. A corrupted
  // next_page pointer can walk into a different table's page without ever
  // raising an error, so trusting that baseline everywhere would be wrong.
  const baselineCounts = new Map<number, number>()
  for (const t of ALL_TABLE_TYPES) baselineCounts.set(t, before.rows(t).length)

  const scan = scanPdbPages(sourceForRepair)
  const rebuilt = rebuildPdbFromScan(scan)
  notes.push(...rebuilt.summary.notes)

  const tempPath = `${opts.corruptedPdbPath}.salvage-tmp`
  writeFileSync(tempPath, rebuilt.buffer)

  const after = new Database(readFileSync(tempPath))
  const regressed: string[] = []
  for (const t of ALL_TABLE_TYPES) {
    if (before.tableErrors.has(t)) continue // baseline itself was already untrustworthy for this table
    if (EXCLUDED_FROM_REGRESSION_FLOOR.has(t)) continue
    const baseline = baselineCounts.get(t) ?? 0
    if (after.rows(t).length < baseline) {
      regressed.push(`${TableType[t] ?? t}: had ${baseline}, rebuilt has ${after.rows(t).length}`)
    }
  }
  const verified = after.tableErrors.size === 0 && regressed.length === 0

  const summary = {
    usbBackupPath,
    localBackupPath,
    tracksBefore,
    tracksRecovered: rebuilt.summary.tracksRecovered,
    tracksAfter: after.tracks.length,
    genresRecovered: rebuilt.summary.genresRecovered,
    artistsRecovered: rebuilt.summary.artistsRecovered,
    albumsRecovered: rebuilt.summary.albumsRecovered,
    labelsRecovered: rebuilt.summary.labelsRecovered,
    keysRecovered: rebuilt.summary.keysRecovered,
    playlistsRecovered: rebuilt.summary.playlistsRecovered,
    playlistEntriesRecovered: rebuilt.summary.playlistEntriesRecovered,
    tablesCarriedOverRaw: rebuilt.summary.tablesCarriedOverRaw
  }

  if (!verified) {
    notes.push(
      `Verification FAILED - nothing was applied. remainingTableErrors=${after.tableErrors.size}, ` +
        `regressedTables=${regressed.length ? regressed.join('; ') : 'none'}`
    )
    return { ...summary, verified: false, appliedPath: null, notes }
  }

  // Only now, atomically swap the verified file into place - same-volume
  // rename is atomic on both APFS and exFAT.
  renameSync(tempPath, opts.corruptedPdbPath)
  notes.push(
    `Best-effort salvage applied: rebuilt from surviving pages only, no independent source to check against. ` +
      `${opts.corruptedPdbPath} now has ${after.tracks.length} tracks, ${after.playlistTree.length} playlists, ` +
      `${after.playlistEntries.length} playlist entries. Confirmed on real hardware: real Rekordbox software ` +
      `currently rejects this rebuilt file ("Device library is corrupted") - the tracks/playlists are genuinely ` +
      `recovered and viewable in this tool, but don't yet assume this will work in Rekordbox or on a CDJ.`
  )

  return { ...summary, verified: true, appliedPath: opts.corruptedPdbPath, notes }
}
