/**
 * Rebuilds a fresh, valid `export.pdb` from salvaged rows - plan §3 steps 3-5.
 *
 * Follows github.com/fragmede/rekordbox-pdb's validated write mechanics
 * (heap allocation, row-directory management, presence/written bitmasks,
 * dynamic page allocation) by reusing PdbEditor itself, rather than
 * deriving them from the spec independently - PdbEditor's own doc comment
 * says it deliberately never synthesizes a from-scratch pdb because the
 * index-page heap layout was "only partially understood"; that's resolved
 * here (see buildSkeleton) so the rest of PdbEditor - the
 * hardware-validated append/lookup/playlist logic - never needs to change.
 *
 * Ground rules (plan §3): returns bytes only; the caller is responsible for
 * the backup-then-verify-then-atomic-swap sequence, not this module.
 */
import { PdbEditor } from './pdbEditor'
import { TableType } from './pdbConstants'
import type { Genre, Artist, Album, Key, Track, PlaylistTreeNode, PlaylistEntry } from './pdbReader'
import type { PageScanResult, ScannedPage } from './pdbPageScanner'
import { salvageRowsFromPage, type SalvagedRow } from './pdbRowSalvage'

const PAGE_HEADER_SIZE = 0x28
const NUM_TABLE_TYPES = 20 // TableType enum's range, 0..19
/** Real terminal-chain sentinel for a page's next_page field (confirmed via Ghidra/lldb - TE_Dpgm_CheckPageHeader/CheckPageData treat this, and 0, as "no more pages", never as a real page number). */
const TERMINAL_NEXT_PAGE = 0x3ffffff

/** Tables with a validated writer in PdbEditor - everything else is carried over raw. */
const RECONCILABLE_TABLES: number[] = [
  TableType.TRACKS,
  TableType.GENRES,
  TableType.ARTISTS,
  TableType.ALBUMS,
  TableType.LABELS,
  TableType.KEYS,
  TableType.PLAYLIST_TREE,
  TableType.PLAYLIST_ENTRIES
]

export interface RebuildSummary {
  tracksRecovered: number
  genresRecovered: number
  artistsRecovered: number
  albumsRecovered: number
  labelsRecovered: number
  keysRecovered: number
  playlistsRecovered: number
  playlistEntriesRecovered: number
  /** Table types with no validated writer, whose surviving pages were relocated verbatim. */
  tablesCarriedOverRaw: string[]
  /** Human-readable notes on what couldn't be reconstructed, if anything. */
  notes: string[]
}

export interface RebuildResult {
  /** The rebuilt file's bytes - caller writes this to a temp path, not the canonical one. */
  buffer: Buffer
  summary: RebuildSummary
}

/**
 * Builds a minimal, empty, structurally-valid pdb: a file header with a
 * 20-entry table directory, and one "index" page per table type. Every
 * table's directory entry starts with firstPage = lastPage = its own
 * index page, matching a genuinely empty table in a real export - this is
 * the state PdbEditor's addTrack/createPlaylist/etc. already know how to
 * grow from via allocatePage(), so nothing in pdbEditor.ts needs to change.
 *
 * Wherever the scan found the table's OWN original index page still
 * intact, that page is reused verbatim rather than synthesized - index
 * pages sit near the front of the file and almost always survive
 * truncation, and reusing the real bytes preserves whatever
 * table-specific fields real Rekordbox wrote there without needing to
 * understand their meaning. Confirmed necessary on real hardware: TRACKS
 * (and likely other actively-maintained tables - FORMAT.md notes 2 of 20
 * index pages get updated across saves, unlike the other 18 static ones)
 * carries header fields in this region that don't match the generic
 * synthesized pattern used for simple lookup tables, and a synthesized
 * TRACKS index page was rejected by real Rekordbox even after fixing two
 * other confirmed structural bugs in the synthesized path.
 *
 * emptyCandidate is deliberately NOT assigned here for any table - see
 * reserveEmptyCandidates(), called after raw carry-over has claimed
 * whatever page numbers it needs, so the two never collide.
 */
/**
 * Physical page number for each table's index page. TRACKS gets page 1
 * with page 2 reserved exclusively for its first real data page -
 * everything else shifts to start at page 3. Confirmed required on real
 * hardware: real Rekordbox's own device-library validity check reads
 * only the first 16KB (4 pages) of export.pdb and rejects the file if
 * page 2 isn't TRACKS' own data (flags=0x24, table type TRACKS) -
 * regardless of how correct every individual page's own content is, the
 * PHYSICAL LAYOUT of the first few pages matters. A rebuild that puts
 * all 20 tables' index pages consecutively (page 2 = the second table's
 * index) fails this check even when every other structural detail is
 * byte-correct.
 */
/**
 * Physical page number for each table's index page: 2*type+1, with the
 * table's own first data page immediately following at 2*type+2. Confirmed
 * against two independent real, working references (a fresh single-track
 * export and a real, years-edited 1293-track device): both show TRACKS=1,
 * GENRES=3, ARTISTS=5, ALBUMS=7, LABELS=9, KEYS=11, COLORS=13, exactly
 * matching this formula for every table, not just TRACKS. A previous
 * version of this function only special-cased TRACKS (page 1, page 2
 * reserved) and used a flatter `2+type` scheme for every other table -
 * which happened to coincidentally match this formula for GENRES (the
 * second table) but drifted further off with every subsequent table,
 * compressing 19 tables' worth of index+data page pairs into far fewer
 * physical pages than real Rekordbox ever uses. That drift is very likely
 * why real Rekordbox's own parser - confirmed via fs_usage to read
 * page-by-page through the table directory in type order - got through
 * TRACKS/GENRES/ARTISTS/ALBUMS/LABELS/KEYS fine but stopped exactly at
 * COLORS (the 7th table, where the drift first becomes large enough to
 * apparently matter).
 */
function indexPageFor(tableType: number): number {
  return 2 * tableType + 1
}

/**
 * The file header's own save-sequence number (offset 0x14) must be at
 * least one more than the highest per-page generation counter (offset
 * 0x10) anywhere in the file - confirmed against two independent real,
 * working references (a fresh single-track export and a real,
 * years-edited 1293-track device): both satisfy header >= maxPageGen+1,
 * with real-world margins of 1 and 86 respectively. PdbEditor.finalize()
 * only bumps the header by +1 from wherever it started, which is correct
 * for Tier 0 (incremental edits to an already-consistent file) but wrong
 * here: raw-carried-over tables keep their real, sometimes very large,
 * historical gen values (e.g. HISTORY_ENTRIES showing gen=6923) while the
 * header starts fresh at 0 for a from-scratch rebuild, an inconsistency
 * Tier 0 never produces because it never touches a table with a
 * pre-existing large gen while ALSO resetting the file's own sequence.
 */
/**
 * This project's own gen/sequence mechanism (PdbEditor.markTableTouched())
 * assigns one flat generation number per "save session" - correct for
 * Tier 0 (patching a handful of rows into an already-populated real
 * table, PdbEditor's own hardware-validated regime), but a from-scratch
 * rebuild bulk-writes an ENTIRE table (TRACKS: 0 -> 1293 rows) in one
 * session, something Tier 0 never exercises. Per the same hardware-
 * bisected spec as the TRACKS/HISTORY header-page fix above
 * (morizkraemer/fourfour PIONEER.md, `reference/pioneer-fourfour/`,
 * CDJ-3000 binary bisection testing), real Rekordbox's own per-page
 * `sequence` (this project's "gen", page offset 0x10) instead follows
 * `base + (cumulative_row_count_through_this_page - 1) * 5`, walking a
 * table's pages in chain order, with a specific base value per table
 * type - NOT a single flat value across every page. Documented for
 * TRACKS/ARTISTS/ALBUMS/PLAYLIST_TREE/PLAYLIST_ENTRIES specifically (not
 * GENRES/LABELS/KEYS - left alone, no hardware data available for them;
 * not COLORS - raw-carried in this project's model, so its real gen is
 * already preserved verbatim from the source scan). Applied as a
 * post-processing correction here rather than changing PdbEditor's own
 * write path, to avoid touching logic this project's own header comment
 * already calls hardware-validated and not needing to change.
 */
const SEQUENCE_BASE_BY_TABLE: Partial<Record<number, number>> = {
  [TableType.TRACKS]: 10,
  [TableType.ARTISTS]: 7,
  [TableType.ALBUMS]: 9,
  [TableType.PLAYLIST_TREE]: 6,
  [TableType.PLAYLIST_ENTRIES]: 11
}

/**
 * Page 0x20/0x22 and each row group's second footer word are DeviceSQL's
 * record of the page's last write (rows touched, first touched index -
 * chrisle/rbxport docs, `_TE_PSmgrClearDirtyBits`). PdbEditor records the
 * whole rebuild as one save, so every row reads as just written:
 * (rowCount, 0) and transaction mask = presence mask. The real pristine
 * device (accepted by the XDJ-700) shows (1, lastRow) with only the last
 * row's bit on every page of tables 1-5 and 8 and most TRACKS pages, and
 * haivala/dj-usb-tkit (hardware-passing on CDJ-2000/NXS/NXS2/XDJ-1000MK2)
 * writes the same, calling tranrf == rowpf "unsafe on older PDB-first
 * hardware players". Rewrite the rebuilt tables to that shape.
 */
const LAST_ROW_WRITE_RECORD_TABLES = [0, 1, 2, 3, 4, 5, 8]

function applyLastRowWriteRecord(buf: Buffer, pageSize: number): void {
  for (const t of LAST_ROW_WRITE_RECORD_TABLES) {
    const dirOff = tableDirOffset(buf, t)
    const last = buf.readUInt32LE(dirOff + 12)
    let cur = buf.readUInt32LE(dirOff + 8)
    const visited = new Set<number>()
    while (!visited.has(cur) && (cur + 1) * pageSize <= buf.length) {
      visited.add(cur)
      const off = cur * pageSize
      const flags = buf[off + 0x1b]!
      const n = buf[off + 0x18]! + 0x100 * (buf[off + 0x19]! & 1)
      if (!(flags & 0x40) && n > 0) {
        for (let group = 0; group < Math.ceil(n / 16); group++) {
          buf.writeUInt16LE(0, off + pageSize - group * 0x24 - 2)
        }
        const lastRow = n - 1
        const groupBase = off + pageSize - Math.floor(lastRow / 16) * 0x24
        buf.writeUInt16LE(1 << lastRow % 16, groupBase - 2)
        buf.writeUInt16LE(1, off + 0x20)
        buf.writeUInt16LE(lastRow, off + 0x22)
      }
      if (cur === last) break
      cur = buf.readUInt32LE(off + 0xc)
    }
  }
}

function applyHardwareSequenceFormula(buf: Buffer, pageSize: number): void {
  for (const [tableStr, base] of Object.entries(SEQUENCE_BASE_BY_TABLE)) {
    const t = Number(tableStr)
    const dirOff = tableDirOffset(buf, t)
    const first = buf.readUInt32LE(dirOff + 8)
    const last = buf.readUInt32LE(dirOff + 12)
    let cur = first
    let cumulativeRows = 0
    const visited = new Set<number>()
    while (!visited.has(cur)) {
      visited.add(cur)
      const off = cur * pageSize
      const flags = buf[off + 0x1b]
      if (!(flags! & 0x40)) {
        // data page, not the index page
        const b24 = buf[off + 24] ?? 0
        const b25 = buf[off + 25] ?? 0
        const numRows = b24 + 0x100 * (b25 & 1)
        cumulativeRows += numRows
        if (numRows > 0) {
          buf.writeUInt32LE(base! + (cumulativeRows - 1) * 5, off + 0x10)
        }
      }
      if (cur === last) break
      cur = buf.readUInt32LE(off + 0xc)
    }
  }
}

function ensureHeaderSequenceCoversMaxGen(buf: Buffer, pageSize: number): void {
  const totalPages = Math.floor(buf.length / pageSize)
  let maxGen = 0
  for (let p = 1; p < totalPages; p++) {
    maxGen = Math.max(maxGen, buf.readUInt32LE(p * pageSize + 0x10))
  }
  const headerSeq = buf.readUInt32LE(0x14)
  if (headerSeq < maxGen + 1) buf.writeUInt32LE(maxGen + 1, 0x14)
}

/**
 * Raw-carried-over tables (see carryOverRawTable()) preserve their
 * original terminal next_page verbatim, unmodified - correct for a file
 * whose overall size roughly matches the source it came from, but this
 * rebuild is typically far more compact than whatever multi-year, heavily-
 * edited original it salvaged from (fewer total pages), so a preserved raw
 * value can end up pointing at a page number the header's own
 * next_unused_page counter never grew high enough to cover. The real
 * engine's page-header validation (TE_Dpgm_CheckPageHeader, via Ghidra)
 * requires next_page to be strictly less than next_unused_page - never
 * equal, never greater - for every single page in every table, reconciled
 * or raw alike. Scan every table's terminal page after all other
 * finalization and raise next_unused_page past the highest one found.
 */
function ensureNextUnusedPageCoversAllTerminalPointers(buf: Buffer, pageSize: number): void {
  let maxTerminalNextPage = buf.readUInt32LE(12) - 1
  for (let t = 0; t < NUM_TABLE_TYPES; t++) {
    const dirOff = tableDirOffset(buf, t)
    const lastPage = buf.readUInt32LE(dirOff + 12)
    const nextPage = buf.readUInt32LE(lastPage * pageSize + 0x0c)
    if (nextPage === 0x3ffffff) continue // the real terminal-chain sentinel, not a page number
    maxTerminalNextPage = Math.max(maxTerminalNextPage, nextPage)
  }
  const nextUnusedPage = buf.readUInt32LE(12)
  if (nextUnusedPage <= maxTerminalNextPage) {
    buf.writeUInt32LE(maxTerminalNextPage + 1, 12)
  }
}

/**
 * TE_Dpgm_CheckPageData (the real engine's page-chain validator, via
 * Ghidra) enforces a THIRD, separate invariant beyond next_unused_page:
 * every page's own next_page, at every step while walking a table's chain
 * from its first_page, must never exceed that SAME table's own
 * empty_candidate directory field - a per-table bound, distinct from the
 * global header counter appendBlankTerminatorsForRawTables()/
 * ensureNextUnusedPageCoversAllTerminalPointers() maintain. Neither of
 * those touches empty_candidate itself, so it's left holding whatever
 * placeholder buildSkeleton() gave it while chain pages further along get
 * raised to the file's true frontier - the exact mismatch this check
 * catches. Critically, the real validator walks the chain via next_page
 * links starting from first_page - it does NOT trust the directory's own
 * last_page field, which can diverge from where the chain actually
 * terminates (confirmed: syncing against last_page alone left 5 tables
 * still failing on an *intermediate* chain page, not just at the true
 * end). Must walk the real chain and cover every next_page seen along it.
 */
function syncEmptyCandidateWithTerminalNextPage(buf: Buffer, pageSize: number): void {
  const totalPages = Math.floor(buf.length / pageSize)
  for (let t = 0; t < NUM_TABLE_TYPES; t++) {
    const dirOff = tableDirOffset(buf, t)
    let cur = buf.readUInt32LE(dirOff + 8) // first_page
    let maxNextPage = 0
    const visited = new Set<number>()
    while (cur < totalPages && !visited.has(cur)) {
      visited.add(cur)
      const nextPage = buf.readUInt32LE(cur * pageSize + 0x0c)
      if (nextPage !== 0x3ffffff) maxNextPage = Math.max(maxNextPage, nextPage)
      if (nextPage === 0 || nextPage === 0x3ffffff) break
      cur = nextPage
    }
    if (maxNextPage === 0) continue // no data page yet - leave the reserved-first-page placeholder alone
    const emptyCandidate = buf.readUInt32LE(dirOff + 4)
    if (emptyCandidate < maxNextPage) {
      buf.writeUInt32LE(maxNextPage, dirOff + 4)
    }
  }
}

function buildSkeleton(scan: PageScanResult): Buffer {
  const pageSize = scan.pageSize
  // page 0 (header) + an index+data page PAIR for every one of the 20
  // tables (matching indexPageFor's 2*type+1/2*type+2 layout) = 41 pages.
  const buf = Buffer.alloc((1 + 2 * NUM_TABLE_TYPES) * pageSize)

  buf.writeUInt32LE(pageSize, 0x04)
  buf.writeUInt32LE(NUM_TABLE_TYPES, 0x08)
  // Unidentified field, confirmed non-zero (value 5) and required on a
  // real device - preserved from the original header (page 0 almost
  // always survives truncation) rather than left at 0, same reasoning as
  // reusing original index pages verbatim.
  buf.writeUInt32LE(scan.originalHeaderField0x10, 0x10)
  buf.writeUInt32LE(0, 0x14) // save sequence number; PdbEditor.finalize() bumps this on first save

  for (let t = 0; t < NUM_TABLE_TYPES; t++) {
    const indexPage = indexPageFor(t)
    const dirOff = 0x1c + t * 16
    buf.writeUInt32LE(t, dirOff) // type
    buf.writeUInt32LE(indexPage, dirOff + 8) // first_page
    buf.writeUInt32LE(indexPage, dirOff + 12) // last_page
    // Every table's empty_candidate is its own reserved data page
    // (indexPage+1, per indexPageFor's layout), matching how real
    // Rekordbox reserves an index+data pair for every table upfront, not
    // just TRACKS. Raw carry-over and reconcilable-table replay both rely
    // on this being set correctly - allocatePage() reads it directly, and
    // carryOverRawTable() relocates a table's first surviving page here.
    buf.writeUInt32LE(indexPage + 1, dirOff + 4)

    const pageOff = indexPage * pageSize
    const original = (scan.pagesByTable.get(t) ?? []).find((p) => p.isIndexPage)
    const isReconcilable = RECONCILABLE_TABLES.includes(t)

    if (original) {
      // Reuse verbatim, only patching self-index to the new physical
      // position. heap+4 (the "first data page" pointer) is reset to the
      // empty sentinel: the original pointed at real data we're not
      // reusing in place (it's being decoded+replayed, or carried over,
      // as fresh pages appended later), and allocatePage() in
      // pdbEditor.ts already knows how to patch this sentinel in
      // correctly on the first new allocation - same mechanism either way.
      original.data.copy(buf, pageOff)
      buf.writeUInt32LE(indexPage, pageOff + 0x04)
      // heap+0 mirrors the page's own physical number too (separately
      // from the header's self-index at 0x04) - confirmed missing via
      // direct real-device comparison: COLORS relocated from its
      // original page 13 to a new physical page still showed heap+0=13
      // (the stale original value) instead of its new number, the first
      // concrete divergence real Rekordbox's parser hit before stopping.
      buf.writeUInt32LE(indexPage, pageOff + PAGE_HEADER_SIZE)
      buf.writeUInt32LE(0x03ffffff, pageOff + PAGE_HEADER_SIZE + 4)
      // Reset the index page's own write-generation counter (offset
      // 0x10) to 1 for RECONCILABLE tables only - confirmed against a
      // genuinely fresh, real, real-Rekordbox-produced export (native
      // "first export to this device" test, not a years-old edited
      // device): every index page sits at gen=1, and gen=0 never appears
      // anywhere in that reference file. 1 is the generation counter's
      // actual starting value, not 0. Left at the original (often much
      // larger, historical) value instead, it poisons
      // markTableTouched()'s chain-max-plus-one calculation the moment
      // this table's first new page is allocated, producing an
      // implausible generation number for what's actually fresh data.
      //
      // Raw-carried-over tables keep their ORIGINAL gen: we're not
      // rewriting their data at all, and forcing gen=1 while preserving
      // their original (possibly nonzero) touched-state below would
      // create a combination no real file ever shows - HISTORY in
      // particular legitimately carries a real, non-1 gen alongside its
      // touched state, and the two need to stay paired.
      //
      // 2026-10-08: except when the source index page is itself touched
      // (next_offset != 0) - its touched state is carried through below, and
      // every real file pairs touched state with a real gen, never 1.
      if (isReconcilable && original.data.readUInt16LE(0x26) === 0) buf.writeUInt32LE(1, pageOff + 0x10)
      // Same terminal-sentinel fix as carryOverRawTable()'s terminal page,
      // for the case that function never reaches at all: a raw-carried
      // table with genuinely zero rows (dataPages.length === 0) stays on
      // this original index page forever, so IT is the terminal page here,
      // and its verbatim-copied next_page is just as stale/wrong as any
      // other raw-carried terminal pointer. Harmless for tables that DO
      // get data carried over afterward - carryOverRawTable() unconditionally
      // overwrites this same field (indexPageOff + 0x0c) once real data
      // exists, so this only takes effect when nothing else patches it.
      buf.writeUInt32LE(TERMINAL_NEXT_PAGE, pageOff + 0x0c)
    } else {
      // No original index page survived for this table - synthesize one.
      // Confirmed against a real device's own index pages (byte-for-byte,
      // five different simple lookup tables) for everything below - only
      // reached when the original is genuinely gone, which chain-repair
      // couldn't have done anything with either.
      buf.writeUInt32LE(indexPage, pageOff + 0x04) // self index
      buf.writeUInt32LE(t, pageOff + 0x08) // table type
      buf.writeUInt32LE(1, pageOff + 0x10) // gen - see the reused-page branch's comment on why 1, not 0
      buf[pageOff + 0x1b] = 0x64 // index/empty page flag, matches FORMAT.md's observed value
      const heap = pageOff + PAGE_HEADER_SIZE
      buf.writeUInt32LE(indexPage, heap)
      buf.writeUInt32LE(0x03ffffff, heap + 4)
      buf.writeUInt32LE(0x03ffffff, heap + 8)
      buf.writeUInt32LE(0, heap + 12)
    }

    // The free-space entries index (unknowna/unknownb/magic/next_offset/
    // num_entries/first_empty, per djl-analysis.deepsymmetry.org's
    // crate-digger docs) tracks incremental single-row edits accumulated
    // over years of individual saves - confirmed via a genuinely fresh,
    // real, real-Rekordbox-produced export (native "first export to this
    // device" test): EVERY table shows the untouched pattern
    // (next_offset=0/num_entries=0), INCLUDING tracks - which has one
    // real track's worth of data - because a one-shot bulk write, however
    // much data it contains, is not the same thing as having been
    // individually re-saved. Having real data does not imply "touched";
    // only actual post-export incremental edits do, which a rebuild never
    // performs by definition for RECONCILABLE tables (their data is
    // always freshly bulk-written here, whatever the source's history).
    //
    // The one exception: raw-carried-over tables (no validated writer)
    // aren't rewritten at all - their bytes are relocated verbatim - so
    // there's no "fresh bulk write" to reflect for them. HISTORY
    // specifically showed next_offset=1/num_entries=1 even in that same
    // completely fresh single-track reference export, meaning real
    // Rekordbox itself marks it touched on every export regardless of
    // edit history (plausibly collection-wide export history, not
    // device-specific edits) - so its original touched-state, whatever it
    // was on the source, is preserved rather than forced to 0.
    // CORRECTION (2026-09-21): this field is a genuine per-table save/edit
    // counter, not a boolean "was this table ever resaved" flag and not a
    // fixed constant - confirmed live against real Rekordbox software by
    // building a real device library from scratch and watching this exact
    // field increment by exactly 1 on every single "export to device"
    // operation (2 -> 3 -> 4 -> 5 across 4 successive real exports),
    // completely independent of how many tracks were added in each one.
    // The public docs (this project's own earlier FORMAT.md-based model,
    // PIONEER.md, and even the formal crate-digger Kaitai spec, which
    // calls it "always 0 except 1 for history pages") all describe it as
    // a small fixed constant - every one of them was written from small
    // or typical samples where it usually IS 0 or 1, not a real, heavily
    // resynced device. HISTORY reads as a constant 1 almost everywhere
    // because it's typically touched once per session; TRACKS is the
    // table that accumulates real save-count depth (17 on this project's
    // own real 1293-track pristine device, from years of actual re-syncs).
    // A from-scratch rebuild has no way to *compute* the true historical
    // save count - but it doesn't need to: it's salvaging from a real
    // source file that already has its own genuine value for this exact
    // field, so the correct move is to carry it through unchanged, the
    // same treatment HISTORY's touched-state already gets via raw
    // carry-over. Verified via `scratch-diff-rebuild-vs-real.ts`: feeding
    // a real, genuine Rekordbox export back through this project's own
    // rebuild pipeline and diffing the result against the real original
    // found ZERO other field-level discrepancies anywhere in the TRACKS
    // row content at every scale tested (6/12/26/56 real tracks) - this
    // was the one remaining gap.
    // PLAYLIST_TREE joins TRACKS here (2026-10-08): it's touched (next_offset=1,
    // num_entries=1, entry0=0x00801fff) in every real file we have, so a rebuild
    // forcing it untouched was the last index-page difference from the source.
    // Generalized the same day: the GitHub sample files show artists/albums/
    // genres/labels touched too, so every table now carries its source state.
    const preserveOriginalTouchedState = original
    const nextOffset = preserveOriginalTouchedState ? original.data.readUInt16LE(0x26) : 0
    const numEntries = preserveOriginalTouchedState ? original.data.readUInt16LE(PAGE_HEADER_SIZE + 16) : 0
    const originalHeap0x14 = preserveOriginalTouchedState ? original.data.readUInt32LE(0x3c) : undefined
    // unknowna/unknownb: 0x1fff when untouched; carried from the source when
    // preserving touched state (pristine TRACKS has 1/2 here).
    buf.writeUInt16LE(preserveOriginalTouchedState ? original.data.readUInt16LE(0x20) : 0x1fff, pageOff + 0x20)
    buf.writeUInt16LE(preserveOriginalTouchedState ? original.data.readUInt16LE(0x22) : 0x1fff, pageOff + 0x22)
    buf.writeUInt16LE(1004, pageOff + 0x24) // magic
    buf.writeUInt16LE(nextOffset, pageOff + 0x26) // next_offset
    buf.writeUInt16LE(numEntries, pageOff + PAGE_HEADER_SIZE + 16) // num_entries (heap+16, i.e. page offset 0x38)
    for (let i = 0; i < 1004; i++) {
      buf.writeUInt32LE(0xfff81fff, pageOff + PAGE_HEADER_SIZE + 18 + i * 4)
    }
    buf.writeUInt16LE(0x1fff, pageOff + PAGE_HEADER_SIZE + 18 + 1004 * 4) // first_empty sentinel
    // The first `numEntries` slots of that same 1004-entry array are real
    // recorded free-space entries when numEntries > 0, not more empty
    // sentinels - confirmed via the same real-vs-rebuild diff that found
    // this whole field family: a real device's array holds genuine entry
    // values in its first numEntries slots. Carry those specific slots
    // through from the source verbatim, same reasoning as nextOffset/
    // numEntries/heap+0x14 above.
    // Every real file (pristine + 3 GitHub samples) lays these out as u16 at
    // page+0x3a followed by u32 entries from page+0x3c - two bytes later than
    // the heap+18 stride above assumes - and often holds more live entries than
    // num_entries says. Copy the whole tail verbatim rather than modelling it.
    if (preserveOriginalTouchedState) {
      original.data.copy(buf, pageOff + PAGE_HEADER_SIZE + 18, PAGE_HEADER_SIZE + 18, original.data.length)
    }

    // ROUND 36 (2026-09-21): both round29's hardcoded-constant approach and
    // round33's force-to-zero approach were wrong, in opposite directions.
    // See the comment above `preserveOriginalTouchedState` for the full
    // story - this field is a real per-table save-count that TRACKS
    // accumulates same as HISTORY does, and the only thing a from-scratch
    // rebuild can correctly do is carry the source's own value through.
    // `nextOffset`/`numEntries` (page+0x26 / heap+0x38) are already handled
    // above via `preserveOriginalTouchedState`, now covering TRACKS too.
    // heap+0x14 (page+0x3c) still needs its own write here: HISTORY keeps
    // its hardware-verified constant (0x140, from PIONEER.md, confirmed
    // against this project's own real pristine device), while TRACKS uses
    // the carried-through original value - falling back to the generic
    // filler pattern (untouched) only in the edge case where no original
    // TRACKS index page survived to carry a value from at all.
    if (t === TableType.HISTORY) {
      buf.writeUInt32LE(0x140, pageOff + 0x3c)
    } else if (originalHeap0x14 !== undefined) {
      buf.writeUInt32LE(originalHeap0x14, pageOff + 0x3c)
    }
  }

  return buf
}

function tableDirOffset(buf: Buffer, tableType: number): number {
  const numTables = buf.readUInt32LE(8)
  for (let i = 0; i < numTables; i++) {
    const off = 0x1c + i * 16
    if (buf.readUInt32LE(off) === tableType) return off
  }
  throw new Error(`no table directory entry for type ${tableType}`)
}

/**
 * Relocates a non-reconcilable table's surviving data pages verbatim,
 * chained after its index page. No row content is ever interpreted - only
 * self-index (0x04) and next_page (0x0c) are patched, which is why this is
 * safe to do without a validated writer for these table types.
 *
 * The FIRST surviving page goes into the table's own pre-reserved data
 * page (buildSkeleton's indexPage+1, already sitting empty in the
 * buffer) rather than being appended at the end - matching real
 * Rekordbox's own fixed index+data page pairing (confirmed via
 * indexPageFor's doc comment) instead of leaving that reserved slot
 * unused and creating an entirely separate chain further out in the
 * file. Only a SECOND or later surviving page (tables with more than one
 * data page's worth of content) needs to be freshly appended.
 */
function carryOverRawTable(buf: Buffer, pageSize: number, tableType: number, dataPages: ScannedPage[]): Buffer {
  if (dataPages.length === 0) return buf
  const sorted = [...dataPages].sort((a, b) => a.index - b.index)
  const reservedFirstPage = indexPageFor(tableType) + 1
  const extraCount = sorted.length - 1
  const startPage = Math.floor(buf.length / pageSize) // where 2nd+ pages land, if any

  const grown = Buffer.alloc(buf.length + extraCount * pageSize)
  buf.copy(grown)

  // First page: into the reserved slot.
  const firstOff = reservedFirstPage * pageSize
  sorted[0]!.data.copy(grown, firstOff)
  grown.writeUInt32LE(reservedFirstPage, firstOff + 0x04) // self index
  if (extraCount > 0) {
    grown.writeUInt32LE(startPage, firstOff + 0x0c) // next_page -> first extra page
  } else {
    // Single-page table: this page is also the terminal page - see the
    // sentinel comment below, same reasoning applies here.
    grown.writeUInt32LE(TERMINAL_NEXT_PAGE, firstOff + 0x0c)
  }

  // Any remaining pages: freshly appended after the current end of file.
  for (let i = 1; i < sorted.length; i++) {
    const newIndex = startPage + (i - 1)
    const destOff = newIndex * pageSize
    sorted[i]!.data.copy(grown, destOff)
    grown.writeUInt32LE(newIndex, destOff + 0x04) // self index
    if (i + 1 < sorted.length) {
      grown.writeUInt32LE(startPage + i, destOff + 0x0c) // next_page -> the next relocated page
    } else {
      // Terminal page of this table's chain. Previously this was left as
      // the verbatim carried-over original next_page value, reasoning that
      // real Rekordbox does the same (confirmed on real files - e.g.
      // COLUMNS' own terminal page pointed at whatever page physically
      // followed it in the ORIGINAL, much larger source file, not 0).
      // That's true in the original file, where the stale pointer still
      // landed on legitimate data - but this rebuild is far more compact,
      // so after compaction/renumbering that same stale page number now
      // very likely lands on a page belonging to a DIFFERENT table.
      // Confirmed via live lldb tracing (2026-09-18) against the real
      // engine's own validator (TE_Dpgm_CheckPageData/TE_Pgm_CheckFlatRow):
      // it does NOT stop at this project's own directory-declared
      // last_page - it just follows raw next_page links until a genuine
      // terminal sentinel, so a stale in-bounds-but-wrong pointer silently
      // walks it into the wrong table's rows and fails there. All 12
      // raw-carried tables in a real rejected rebuild were found to have
      // this exact defect. Force a genuine terminal sentinel instead.
      grown.writeUInt32LE(TERMINAL_NEXT_PAGE, destOff + 0x0c)
    }
  }

  const dirOff = tableDirOffset(grown, tableType)
  const indexPage = grown.readUInt32LE(dirOff + 8) // first_page, still the table's original index page
  const indexPageOff = indexPage * pageSize
  grown.writeUInt32LE(reservedFirstPage, indexPageOff + 0x0c) // index page's next_page -> first (reserved) data page
  const lastPage = extraCount > 0 ? startPage + extraCount - 1 : reservedFirstPage
  grown.writeUInt32LE(lastPage, dirOff + 12) // last_page
  // Same "first data page" heap patch allocatePage() does for the
  // decode+replay path (pdbEditor.ts) - skipping it here left the
  // directory saying "this table has data" while the index page's own
  // heap still claimed "no data page yet" (0x03FFFFFF), an internal
  // inconsistency real Rekordbox's own validator catches even though
  // this project's reader never looks at this field at all.
  const heap = indexPageOff + PAGE_HEADER_SIZE
  if (grown.readUInt32LE(heap + 4) === 0x03ffffff) {
    grown.writeUInt32LE(reservedFirstPage, heap + 4)
  }

  return grown
}

/**
 * Resolves every raw-carried table's TERMINAL_NEXT_PAGE placeholder
 * (written by carryOverRawTable()/buildSkeleton() above) into a REAL,
 * appended, genuinely-blank (all-zero) page instead.
 *
 * Originally this project just left TERMINAL_NEXT_PAGE (0x3ffffff) in
 * place directly - technically valid per the real engine's decompiled
 * desktop validator (TE_Dpgm_CheckPageHeader/TE_Dpgm_CheckPageData both
 * explicitly special-case 0x3ffffff as a stop marker) and it did get
 * round 25 accepted by the Mac Rekordbox app. But real CDJ/XDJ hardware
 * FROZE SOLID (required a full power-cycle) when browsing into that same
 * file - confirmed on real XDJ-700 hardware, 2026-09-18. Checked whether
 * the real, hardware-proven pristine reference file EVER uses 0x3ffffff
 * anywhere at all, in any page, for any purpose: zero occurrences across
 * all 337 pages. Real Rekordbox's own writer never produces this value -
 * it's evidently dead/untested code on whatever firmware CDJs actually
 * run, even though the desktop app's own validator tolerates it fine.
 *
 * Every raw table's terminal page in the real pristine file instead
 * points at a REAL, in-bounds page number that (thanks to the original,
 * much larger, sparser file's own edit history) happens to be genuinely
 * blank/never-written space - confirmed by direct inspection (flags=0x00,
 * type=0, i.e. subtype 0, which the real validator's own subtype dispatch
 * skips CheckPsmgrHeader/CheckFlatRow for entirely). This rebuild has no
 * such naturally-occurring blank space (it's maximally compacted), so
 * this pass manufactures the equivalent: append a dedicated, fully
 * zeroed page (Buffer.alloc default - byte-for-byte the same shape as a
 * real never-written page) for each table that needs one, and point that
 * table's terminal next_page at its REAL page number - never an exotic
 * sentinel value with no real-world precedent.
 *
 * Must also bump each touched table's own empty_candidate directory field
 * (dirOff+4) to cover the new page number. TE_Dpgm_CheckPageData (via
 * Ghidra) enforces a THIRD invariant beyond CheckPageHeader's own checks:
 * every next_page value seen while walking a table's chain must stay
 * <= that SAME table's own empty_candidate field (unless it's the
 * 0x3ffffff sentinel) - this is the exact same invariant
 * syncEmptyCandidateWithTerminalNextPage() maintains elsewhere, but that
 * function runs BEFORE this one (has to - this one needs the final,
 * fully-carried-over layout) and so never saw these new, higher page
 * numbers. First attempt at this fix (round 27) missed this and got
 * rejected by the desktop app - confirmed round27 regressed relative to
 * round25 specifically because of this, not a hardware-only issue.
 */
function appendBlankTerminatorsForRawTables(buf: Buffer, pageSize: number): Buffer {
  const placeholders: { table: number; lastPage: number }[] = []
  for (let t = 0; t < NUM_TABLE_TYPES; t++) {
    if (RECONCILABLE_TABLES.includes(t)) continue
    const dirOff = tableDirOffset(buf, t)
    const lastPage = buf.readUInt32LE(dirOff + 12)
    const lastPageOff = lastPage * pageSize
    if (lastPageOff + pageSize > buf.length) continue
    if (buf.readUInt32LE(lastPageOff + 0x0c) === TERMINAL_NEXT_PAGE) {
      placeholders.push({ table: t, lastPage })
    }
  }
  if (placeholders.length === 0) return buf

  // Start past next_unused_page, not just past the file's end: the last
  // reconcilable table to grow has reserved the page right at EOF as its
  // empty_candidate (allocatePage()), and reusing that number here made two
  // tables share one empty page - something no real file does.
  const startPage = Math.max(Math.floor(buf.length / pageSize), buf.readUInt32LE(12))
  const grown = Buffer.alloc((startPage + placeholders.length) * pageSize)
  buf.copy(grown)

  placeholders.forEach(({ table, lastPage }, i) => {
    const newPage = startPage + i
    // Left entirely zero, self index included - every spare page on the real
    // pristine device is all-zero (checked 2026-10-08).
    grown.writeUInt32LE(newPage, lastPage * pageSize + 0x0c) // repoint the raw table's terminal page at this real blank page
    const dirOff = tableDirOffset(grown, table)
    if (grown.readUInt32LE(dirOff + 4) < newPage) {
      grown.writeUInt32LE(newPage, dirOff + 4) // empty_candidate must cover every next_page seen while walking this table's chain
    }
  })

  grown.writeUInt32LE(startPage + placeholders.length, 12) // header next_unused_page, covering the newly appended pages
  return grown
}

/** Dedups salvaged rows for one table by their own original numeric id - the highest original page index wins on collision (two overlapping/duplicate scanned pages of the same row). */
function dedupById<T extends { id: number }>(salvaged: SalvagedRow[]): Map<number, T> {
  const winners = new Map<number, { pageIndex: number; parsed: T }>()
  for (const row of salvaged) {
    const parsed = row.parsed as T
    const existing = winners.get(parsed.id)
    if (!existing || row.pageIndex > existing.pageIndex) winners.set(parsed.id, { pageIndex: row.pageIndex, parsed })
  }
  const result = new Map<number, T>()
  for (const [id, w] of winners) result.set(id, w.parsed)
  return result
}

export function rebuildPdbFromScan(scan: PageScanResult): RebuildResult {
  const pageSize = scan.pageSize
  const notes: string[] = []
  const tablesCarriedOverRaw: string[] = []

  let buf = buildSkeleton(scan)

  // Raw carry-over: every table's empty_candidate was already set by
  // buildSkeleton() to its own reserved data page, so no separate
  // reservation pass is needed for reconcilable tables afterward -
  // allocatePage() (pdbEditor.ts) reads that directory field directly the
  // moment a reconcilable table's first row gets replayed.
  for (let t = 0; t < NUM_TABLE_TYPES; t++) {
    if (RECONCILABLE_TABLES.includes(t)) continue
    const pages = (scan.pagesByTable.get(t) ?? []).filter((p) => !p.isIndexPage)
    if (pages.length === 0) continue
    buf = carryOverRawTable(buf, pageSize, t, pages)
    tablesCarriedOverRaw.push(TableType[t] ?? `table type ${t}`)
  }

  buf.writeUInt32LE(Math.floor(buf.length / pageSize), 12) // header next_unused_page, reflecting any raw carry-over growth

  const editor = new PdbEditor(buf)

  // -- decode salvaged rows for the reconcilable tables --------------------
  function salvageTable(tableType: number): SalvagedRow[] {
    const pages = (scan.pagesByTable.get(tableType) ?? []).filter((p) => !p.isIndexPage)
    const rows: SalvagedRow[] = []
    for (const page of pages) rows.push(...salvageRowsFromPage(page))
    return rows
  }

  const genres = dedupById<Genre>(salvageTable(TableType.GENRES))
  const artists = dedupById<Artist>(salvageTable(TableType.ARTISTS))
  const albums = dedupById<Album>(salvageTable(TableType.ALBUMS))
  const labels = dedupById<Genre>(salvageTable(TableType.LABELS)) // Label = Genre shape
  const keys = dedupById<Key>(salvageTable(TableType.KEYS))
  const tracks = dedupById<Track>(salvageTable(TableType.TRACKS))
  const playlists = dedupById<PlaylistTreeNode>(salvageTable(TableType.PLAYLIST_TREE))
  const playlistEntriesRaw = salvageTable(TableType.PLAYLIST_ENTRIES)

  const genreNameById = new Map([...genres].map(([id, g]) => [id, g.name]))
  const artistNameById = new Map([...artists].map(([id, a]) => [id, a.name]))
  const albumNameById = new Map([...albums].map(([id, a]) => [id, a.name]))
  // An album's OWN real artist (for compilations, often different from
  // any individual track's own artist) - see the correction comment where
  // this feeds into album pre-creation and `addTrack()`'s `albumArtist`.
  // Uses '' (not undefined) for "this album genuinely has no artist" -
  // `addTrack()` treats undefined as "no info, fall back to the track's
  // own artist" but '' as "explicitly none", and plenty of real albums
  // (not just the 23 duplicate-name pairs) genuinely have artistId=0.
  const albumArtistNameById = new Map(
    [...albums].map(([id, a]) => [id, a.artistId ? (artistNameById.get(a.artistId) ?? '') : ''])
  )
  const labelNameById = new Map([...labels].map(([id, l]) => [id, l.name]))
  const keyNameById = new Map([...keys].map(([id, k]) => [id, k.name]))

  // -- create every genre/artist/album/label/key - both the ones tracks
  // reference AND salvaged-but-orphaned ones - BEFORE replaying any track
  // row, and fully grouped by TYPE (every artist created back-to-back,
  // then every genre, etc.) rather than interleaved with each other or
  // with TRACKS. Confirmed necessary via direct real-device comparison:
  // real Rekordbox's own writer finishes growing each lookup table's
  // chain to completion before another table starts growing its own
  // (their reference implementation's TABLE_LAYOUTS reserves every
  // table's overflow page upfront, during skeleton creation, never
  // interleaved with another table's row-by-row growth). Two earlier,
  // less strict versions of this section (interleaved with TRACKS; then
  // grouped by type but with "referenced by a track" and "orphaned"
  // creation as two SEPARATE passes per type, with other types' growth
  // sandwiched in between) each still left some tables' "reserved next
  // page" permanently unclaimed while another table's later growth
  // extended the file past it - confirmed via fs_usage as exactly where
  // real Rekordbox's own parser stops and rejects the file, reading pages
  // in strict physical sequence rather than following logical chain
  // links. Only a single, fully-contiguous per-type pass (referenced +
  // orphaned together) avoids this.
  const sortedTracks = [...tracks.values()].sort((a, b) => a.id - b.id)

  // Every lookup table is rebuilt in the source's own id order WITH the
  // source's own ids (one contiguous pass per type, referenced + orphaned
  // together, as before). Renumbered ids looked fine to desktop Rekordbox
  // and to name-based checks, but the XDJ-700 v1.15 firmware (run in an
  // emulator) browsed them wrongly: a blank artist and missing artists.
  const referencedArtistIds = new Set<number>()
  for (const t of sortedTracks) {
    for (const id of [t.artistId, t.composerId, t.originalArtistId, t.remixerId]) if (id) referencedArtistIds.add(id)
  }
  let artistsRecovered = 0
  for (const a of [...artists.values()].sort((x, y) => x.id - y.id)) {
    if (!a.name) continue
    editor.getOrCreateArtist(a.name, a.id)
    if (!referencedArtistIds.has(a.id)) artistsRecovered++
  }

  const byId = <T extends { id: number }>(m: Iterable<T>) => [...m].sort((x, y) => x.id - y.id)
  let genresRecovered = 0
  const referencedGenreIds = new Set(sortedTracks.map((t) => t.genreId).filter((id) => id))
  for (const g of byId(genres.values())) {
    if (!g.name) continue
    editor.getOrCreateGenre(g.name, g.id)
    if (!referencedGenreIds.has(g.id)) genresRecovered++
  }

  let keysRecovered = 0
  const referencedKeyIds = new Set(sortedTracks.map((t) => t.keyId).filter((id) => id))
  for (const k of byId(keys.values())) {
    if (!k.name) continue
    editor.getOrCreateKey(k.name, k.id)
    if (!referencedKeyIds.has(k.id)) keysRecovered++
  }

  let labelsRecovered = 0
  const referencedLabelIds = new Set(sortedTracks.map((t) => t.labelId).filter((id) => id))
  for (const l of byId(labels.values())) {
    if (!l.name) continue
    editor.getOrCreateLabel(l.name, l.id)
    if (!referencedLabelIds.has(l.id)) labelsRecovered++
  }

  // Albums last: every artist above already exists (with its original id),
  // so an album's own artistId resolves to the same id it had. Albums that
  // share a name (23 on the real device) stay apart through that artist.
  let albumsRecovered = 0
  const referencedAlbumIds = new Set(sortedTracks.map((t) => t.albumId).filter((id) => id))
  for (const al of byId(albums.values())) {
    if (!al.name) continue
    const artistName = al.artistId ? artistNameById.get(al.artistId) : undefined
    editor.getOrCreateAlbum(al.name, artistName ? editor.getOrCreateArtist(artistName, al.artistId) : 0, al.id)
    if (!referencedAlbumIds.has(al.id)) albumsRecovered++
  }

  // -- playlists, parent-before-child, keyed by original id ----------------
  // Deliberately BEFORE track replay: PLAYLIST_TREE doesn't depend on
  // tracks at all (only PLAYLIST_ENTRIES does, kept after tracks below),
  // and moving it here keeps its own first-ever page allocation in the
  // same early cluster as the other small lookup tables, instead of
  // firing after all 1293 tracks have already advanced the shared
  // next-page counter deep into TRACKS' own territory - confirmed via
  // direct inspection this was stranding PLAYLIST_TREE's single spurious
  // "next page" reservation (allocatePage() always reserves one, even for
  // a table that never grows beyond its first page) right in the middle
  // of what should have been PLAYLIST_ENTRIES' own contiguous block.
  const oldPlaylistIdToNewId = new Map<number, number>([[0, 0]]) // 0 = root in both old and new
  const existingPlaylistsByNameParent = new Map<string, number>()
  let playlistsRecovered = 0
  let remainingPlaylists = [...playlists.values()]
  let progressedPlaylists = true
  while (remainingPlaylists.length && progressedPlaylists) {
    progressedPlaylists = false
    const stillRemaining: typeof remainingPlaylists = []
    for (const p of remainingPlaylists) {
      const newParentId = oldPlaylistIdToNewId.get(p.parentId)
      if (newParentId === undefined) {
        stillRemaining.push(p)
        continue
      }
      const key = `${p.name} ${newParentId}`
      let newId = existingPlaylistsByNameParent.get(key)
      if (newId === undefined) {
        newId = editor.createPlaylist(p.name, newParentId, p.isFolder, p.sortOrder, p.id)
        existingPlaylistsByNameParent.set(key, newId)
        playlistsRecovered++
      }
      oldPlaylistIdToNewId.set(p.id, newId)
      progressedPlaylists = true
    }
    remainingPlaylists = stillRemaining
  }
  if (remainingPlaylists.length) {
    notes.push(
      `${remainingPlaylists.length} playlist(s) could not be placed (broken parent chain): ${remainingPlaylists.map((p) => p.name).join(', ')}`
    )
  }

  // -- tracks, ordered by original id for determinism ----------------------
  const oldTrackIdToNewId = new Map<number, number>()
  let tracksRecovered = 0
  const trackFailures: string[] = []
  for (const t of sortedTracks) {
    try {
      const newId = editor.addTrack(t.title, t.filePath, {
        filename: t.filename || undefined,
        artist: t.artistId ? artistNameById.get(t.artistId) : undefined,
        composer: t.composerId ? artistNameById.get(t.composerId) : undefined,
        originalArtist: t.originalArtistId ? artistNameById.get(t.originalArtistId) : undefined,
        remixer: t.remixerId ? artistNameById.get(t.remixerId) : undefined,
        album: t.albumId ? albumNameById.get(t.albumId) : undefined,
        albumArtist: t.albumId ? albumArtistNameById.get(t.albumId) : undefined,
        genre: t.genreId ? genreNameById.get(t.genreId) : undefined,
        key: t.keyId ? keyNameById.get(t.keyId) : undefined,
        label: t.labelId ? labelNameById.get(t.labelId) : undefined,
        comment: t.comment || undefined,
        mixName: t.mixName || undefined,
        releaseDate: t.releaseDate || undefined,
        analyzePath: t.analyzePath || undefined,
        dateAdded: t.dateAdded || undefined,
        tempo: t.tempo,
        duration: t.duration,
        year: t.year,
        bitrate: t.bitrate,
        sampleRate: t.sampleRate,
        sampleDepth: t.sampleDepth,
        fileSize: t.fileSize,
        trackNumber: t.trackNumber,
        discNumber: t.discNumber,
        rating: t.rating,
        playCount: t.playCount,
        colorId: t.colorId,
        artworkId: t.artworkId,
        formatConst1: t.formatConst1,
        formatConst2: t.formatConst2,
        masterContentId: t.masterContentId,
        rawStrings: t.rawStrings,
        id: t.id
      })
      oldTrackIdToNewId.set(t.id, newId)
      tracksRecovered++
    } catch (err) {
      trackFailures.push(`${t.filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (trackFailures.length) {
    notes.push(
      `${trackFailures.length} salvaged track(s) could not be rebuilt: ${trackFailures.slice(0, 5).join('; ')}${trackFailures.length > 5 ? '...' : ''}`
    )
  }

  // -- playlist entries, deduped post-resolution ----------------------------
  let playlistEntriesRecovered = 0
  let unresolvedEntries = 0
  const entryFailures: string[] = []
  const existingEntries = new Set<string>()
  for (const row of playlistEntriesRaw) {
    const entry = row.parsed as PlaylistEntry
    const newPlaylistId = oldPlaylistIdToNewId.get(entry.playlistId)
    // Track ids are kept as-is, so an entry whose track didn't survive keeps
    // pointing at that id. The real pristine device carries 25 such entries
    // and both Rekordbox and the XDJ-700 accept it.
    const newTrackId = oldTrackIdToNewId.get(entry.trackId) ?? (entry.trackId > 0 ? entry.trackId : undefined)
    if (newPlaylistId === undefined || newTrackId === undefined) {
      unresolvedEntries++
      continue
    }
    const key = `${newPlaylistId} ${newTrackId}`
    if (existingEntries.has(key)) continue
    try {
      editor.addToPlaylist(newPlaylistId, newTrackId, entry.entryIndex > 0 ? entry.entryIndex : undefined)
      existingEntries.add(key)
      playlistEntriesRecovered++
    } catch (err) {
      entryFailures.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (unresolvedEntries) {
    notes.push(`${unresolvedEntries} playlist entry/entries could not be matched to a recovered track or playlist`)
  }
  if (entryFailures.length) {
    notes.push(`${entryFailures.length} playlist entry/entries failed to add: ${entryFailures.slice(0, 5).join('; ')}`)
  }

  let finalBuffer = editor.toBytes()
    // Fix 4: Run FIRST so all subsequent calculations operate on the final layout
  finalBuffer = appendBlankTerminatorsForRawTables(finalBuffer, pageSize)

  // reclaimOrphanedTerminalPages() is no longer called (2026-10-08): it
  // pointed every reconcilable table at one shared page past EOF. The real
  // pristine device gives each table its own spare page - seven of them
  // in-file and all-zero - and Rekordbox accepts that, so a table's own
  // in-file reservation is left as allocatePage() made it.
  applyHardwareSequenceFormula(finalBuffer, pageSize)
  applyLastRowWriteRecord(finalBuffer, pageSize)
  ensureHeaderSequenceCoversMaxGen(finalBuffer, pageSize)
  ensureNextUnusedPageCoversAllTerminalPointers(finalBuffer, pageSize)
  syncEmptyCandidateWithTerminalNextPage(finalBuffer, pageSize)


  return {
    buffer: finalBuffer,
    summary: {
      tracksRecovered,
      genresRecovered,
      artistsRecovered,
      albumsRecovered,
      labelsRecovered,
      keysRecovered,
      playlistsRecovered,
      playlistEntriesRecovered,
      tablesCarriedOverRaw,
      notes
    }
  }
}
