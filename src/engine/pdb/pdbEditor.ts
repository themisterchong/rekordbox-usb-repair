/**
 * Ported from fragmede/rekordbox-pdb (MIT License, Copyright (c) 2026 fragmede)
 * https://github.com/fragmede/rekordbox-pdb - src/rekordbox_pdb/edit.py
 *
 * Follows rekordbox's own write behaviour, as reverse engineered from
 * byte-diffs of consecutive exports of the same library (see that repo's
 * FORMAT.md "Writing"):
 *
 * - Edits are surgical: rekordbox never rewrites the file; it patches
 *   fields in place, appends rows to page heaps, and clears presence bits
 *   to delete. Deleted slots are never reclaimed.
 * - A row appended into slot k gets heap offset = current used_size;
 *   per-table allocation formulas (with 4-byte alignment and, for
 *   track/artist/album rows, a 4-byte tail) determine the next used_size.
 * - Page bookkeeping on append: slot count, present-count field,
 *   previous-count field, the presence bitmask, the written-this-save
 *   bitmask, free_size/used_size, a per-table write-generation stamp, and
 *   the file-header sequence number.
 * - New pages come from the table's empty candidate, which the last
 *   page's next_page already points at.
 *
 * We deliberately do NOT synthesize a from-scratch pdb (the index-page
 * structure is only partially understood, per that repo's own notes) -
 * this editor only ever appends to an existing, structurally valid pdb
 * (e.g. the user's own corrupted-but-mostly-intact file, or a captured
 * real-Rekordbox template). See plan §3 Tier 0.
 */
import { Album, Database, TableType } from './pdbReader'
import { encodeString, stringByteLength } from './pdbStrings'

const PAGE_HEADER_SIZE = 0x28

/** Fixed-width track fields editable in place: name -> [row offset, size]. */
export const TRACK_FIXED_FIELDS: Record<string, [number, number]> = {
  sample_rate: [0x08, 4],
  file_size: [0x10, 4],
  artwork_id: [0x1c, 4],
  key_id: [0x20, 4],
  original_artist_id: [0x24, 4],
  label_id: [0x28, 4],
  remixer_id: [0x2c, 4],
  bitrate: [0x30, 4],
  track_number: [0x34, 4],
  tempo: [0x38, 4],
  genre_id: [0x3c, 4],
  album_id: [0x40, 4],
  artist_id: [0x44, 4],
  disc_number: [0x4c, 2],
  play_count: [0x4e, 2],
  year: [0x50, 2],
  sample_depth: [0x52, 2],
  duration: [0x54, 2],
  color_id: [0x58, 1],
  rating: [0x59, 1]
}

// Confirmed against the real 1293-track device (0x05 appears on 23 real
// .flac rows) and against PIONEER.md's own documented table (1=MP3, 4=M4A,
// 5=FLAC, 11=WAV, 12=AIFF) - the older FORMAT.md this table was originally
// built from never listed FLAC at all, so every real .flac track was
// silently falling through to the `?? 0x01` MP3 default.
/** File-type code at track row offset 0x5a, keyed by extension. */
const FILE_TYPE_CODES: Record<string, number> = {
  '.mp3': 0x01,
  '.m4a': 0x04,
  '.flac': 0x05,
  '.wav': 0x0b,
  '.aiff': 0x0c,
  '.aif': 0x0c
}

// TEST ONLY: RB_REVERT_UTF16_ALIGN=1 restores the pre-round39 (unaligned) string placement,
// to check in an emulator whether that alignment is what stops the XDJ-700 freeze.
const REVERT_UTF16_ALIGN = process.env.RB_REVERT_UTF16_ALIGN === '1'

function align4(n: number): number {
  return (n + 3) & ~3
}

/** Short-ASCII strings have an odd kind byte; long ASCII (0x40) and UTF-16 (0x90) are even. */
function isShortString(encoded: Buffer): boolean {
  return (encoded[0]! & 1) === 1
}

/** Whether an artist/album name gets the 0x64/0x84 long-name row subtype - see buildArtistRow. */
function isLongName(encoded: Buffer): boolean {
  return encoded.length > 214
}

function checkRange(name: string, value: number, size: number): void {
  // NOT `1 << (8*size)`: JS bitwise shifts operate on 32-bit ints, so
  // `1 << 32` silently wraps to 1, not 4294967296 - broke every 4-byte
  // field check (caught by the editor's own round-trip test against the
  // real fixture, see below - even a routine sample_rate=44100 failed).
  const max = 2 ** (8 * size)
  if (!(value >= 0 && value < max)) {
    throw new RangeError(`${name}=${value} does not fit in ${size} byte(s)`)
  }
}

export interface AddTrackOptions {
  filename?: string
  artist?: string
  composer?: string
  originalArtist?: string
  remixer?: string
  album?: string
  // The album's OWN artist, when known, as distinct from the track's own
  // `artist` above - a compilation/various-artist album's own listed
  // artist is often different from any individual track's artist.
  // Defaults to `artist` when omitted (the old, sometimes-wrong
  // behavior), so existing callers that don't have this data available
  // keep working the same way.
  albumArtist?: string
  genre?: string
  key?: string
  label?: string
  comment?: string
  mixName?: string
  releaseDate?: string
  analyzePath?: string
  dateAdded?: string
  tempo?: number
  duration?: number
  year?: number
  bitrate?: number
  sampleRate?: number
  sampleDepth?: number
  fileSize?: number
  trackNumber?: number
  discNumber?: number
  playCount?: number
  rating?: number
  colorId?: number
  artworkId?: number
  // Raw 0x18/0x1a bytes - see the matching comment on Track in pdbReader.ts.
  // Defaults to the value FORMAT.md documents as a constant, for callers
  // (e.g. a genuinely brand-new track) with no historical value to carry over.
  formatConst1?: number
  formatConst2?: number
  // MASTERCONTENTID (0x14) carried from a salvaged row. Without it a fresh
  // unique value is generated, as for a genuinely new track.
  masterContentId?: number
  // Exact encoded bytes for the string slots this editor doesn't model
  // (RAW_STRING_SLOTS), carried from a salvaged row - see Track.rawStrings.
  rawStrings?: readonly Buffer[]
  // Keep this exact track id (a salvaged row's own) instead of max+1, so
  // ids with gaps from deleted tracks survive a rebuild unchanged.
  id?: number
}

// Track string slots with no AddTrackOptions field of their own: ISRC,
// lyricist, the three small counters, message, kuvo_public, autoload_hotcues,
// unknown 8/9/13/18, analyze_date. Real rows vary in all of these, so a
// rebuild must copy them rather than write defaults.
const RAW_STRING_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 15, 18]

/** Edits an export.pdb in memory; write the result with toBytes()/save(). */
export class PdbEditor {
  private buf: Buffer
  private dbCache: Database | null = null
  readonly pageSize: number

  // Per-page append bookkeeping (page_index -> value).
  private origSlots = new Map<number, number>() // slot count before this session
  private appends = new Map<number, number>() // rows appended this session
  // Tables whose pages must get a new write-generation stamp.
  private newGen = new Map<number, number>() // table type -> stamp value
  private touchedPages = new Map<number, Set<number>>() // table type -> pages
  private structural = false
  private finalSequence: number | undefined

  constructor(data: Buffer) {
    this.buf = Buffer.from(data) // copy - never mutate the caller's buffer
    this.pageSize = this.buf.readUInt32LE(4)
  }

  static fromFile(path: string): PdbEditor {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('fs') as typeof import('fs')
    return new PdbEditor(readFileSync(path))
  }

  toBytes(): Buffer {
    this.finalize()
    return Buffer.from(this.buf)
  }

  save(path: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(path, this.toBytes())
  }

  /** The current state, parsed. Reparsed after each mutation. */
  get db(): Database {
    if (this.dbCache === null) {
      this.dbCache = new Database(this.buf)
    }
    return this.dbCache
  }

  private invalidateDb(): void {
    this.dbCache = null
  }

  // -- low-level helpers ---------------------------------------------------

  private ensureCapacity(minLength: number): void {
    if (this.buf.length < minLength) {
      const grown = Buffer.alloc(minLength)
      this.buf.copy(grown)
      this.buf = grown
    }
  }

  private tableEntryOffset(tableType: number): number {
    const numTables = this.buf.readUInt32LE(8)
    for (let i = 0; i < numTables; i++) {
      const off = 0x1c + i * 16
      if (this.buf.readUInt32LE(off) === tableType) return off
    }
    throw new Error(`no table of type ${tableType}`)
  }

  private totalPages(): number {
    return Math.floor(this.buf.length / this.pageSize)
  }

  /**
   * A table's directory entry can point `last_page` at a page that no
   * longer physically exists in a truncated file (plan §1: the exact
   * "unsafe eject mid-write" signature) - appendRow()/allocatePage() would
   * silently read/write garbage against such a pointer rather than erring
   * clearly, since it assumes a structurally valid file.
   *
   * This walks the table's chain from first_page, stops at the last page
   * that's actually present, and reconnects the directory entry to that
   * page - restoring the documented invariant "last_page.next_page ==
   * empty_candidate" by pointing both at the file header's current
   * next_unused_page (safe, unclaimed page space). Call this before
   * appending to any table whose chain might be truncated. A no-op if the
   * chain is already intact.
   */
  repairTruncatedChain(
    tableType: number
  ): { repaired: boolean; lastGoodPage: number | null; rowsBeforeCut: number; unrecoverable: boolean } {
    const entry = this.tableEntryOffset(tableType)
    const firstPage = this.buf.readUInt32LE(entry + 8)
    const declaredLastPage = this.buf.readUInt32LE(entry + 12)
    const total = this.totalPages()

    // The table's very first page doesn't physically exist at all - the
    // whole table was allocated after the truncation point. There's
    // nothing to reconnect a new page to (caught via stress-testing: this
    // previously fell through to writing past the end of the buffer,
    // throwing a raw RangeError instead of failing cleanly). This table
    // needs real salvage (Tier 1, not yet built), not a chain repair.
    if (firstPage >= total) {
      return { repaired: false, lastGoodPage: null, rowsBeforeCut: 0, unrecoverable: true }
    }

    let pageIndex = firstPage
    let lastGood = firstPage
    let rowsBeforeCut = 0
    const visited = new Set<number>()
    while (true) {
      // Page 0 is always the file header/table directory, never a real
      // table's page - a next_page pointer landing there mid-chain is
      // itself corrupted, not a legitimate (if truncated) continuation.
      // Caught via stress-testing: a page holding this table's real
      // next_page field got zeroed by an unrelated corruption elsewhere
      // in the file, so the field read back as 0 - which is a plausible
      // *in-bounds* value, so the old bounds check alone didn't catch it,
      // and the walk went on to treat the file header as this table's
      // "last good page" and write a reconnection into it.
      if (pageIndex === 0 && pageIndex !== firstPage) {
        return { repaired: false, lastGoodPage: null, rowsBeforeCut, unrecoverable: true }
      }
      if (pageIndex >= total || visited.has(pageIndex)) break
      visited.add(pageIndex)
      lastGood = pageIndex
      const pageOff = pageIndex * this.pageSize
      if (!(this.buf[pageOff + 0x1b]! & 0x40)) {
        rowsBeforeCut += this.slotCount(pageOff)
      }
      if (pageIndex === declaredLastPage) {
        return { repaired: false, lastGoodPage: pageIndex, rowsBeforeCut, unrecoverable: false } // chain was already intact
      }
      pageIndex = this.buf.readUInt32LE(pageOff + 0x0c) // next_page
    }

    const nextUnused = this.buf.readUInt32LE(12)
    const lastGoodOff = lastGood * this.pageSize
    this.buf.writeUInt32LE(nextUnused, lastGoodOff + 0x0c) // reconnect next_page
    this.buf.writeUInt32LE(lastGood, entry + 12) // table.last_page
    this.buf.writeUInt32LE(nextUnused, entry + 4) // table.empty_candidate
    // Also reserve that page in the header counter itself, immediately -
    // allocatePage() assumes empty_candidate and the header's
    // next_unused_page are always distinct (a healthy file maintains that
    // naturally; a freshly-repaired one doesn't unless we advance it here
    // too). Without this, the first allocatePage() call claims this same
    // page number as "new" *and* leaves empty_candidate still pointing at
    // it, so a second allocation later silently re-zeroes it - caught via
    // the round-trip test against the real fixture, where it wiped the
    // first 10 of 208 recovered tracks.
    this.buf.writeUInt32LE(nextUnused + 1, 12)
    this.invalidateDb()
    return { repaired: true, lastGoodPage: lastGood, rowsBeforeCut, unrecoverable: false }
  }

  // -- in-place edits -------------------------------------------------------

  /**
   * Patch a fixed-width numeric track field in place. Changes exactly the
   * bytes of that field; bookkeeping fields are left alone (readers don't
   * consult them for in-place patches).
   */
  setTrackField(trackId: number, field: string, value: number): void {
    const entry = TRACK_FIXED_FIELDS[field]
    if (!entry) throw new Error(`not a fixed track field: ${field}`)
    const [offset, size] = entry
    checkRange(field, value, size)
    const locations = this.db.rowLocations(TableType.TRACKS)
    const tracks = this.db.tracks
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i]!.id === trackId) {
        const at = locations[i]! + offset
        if (size === 1) this.buf.writeUInt8(value, at)
        else if (size === 2) this.buf.writeUInt16LE(value, at)
        else this.buf.writeUInt32LE(value, at)
        this.invalidateDb()
        return
      }
    }
    throw new Error(`no track with id ${trackId}`)
  }

  /**
   * Patches a track's `filename` and `file_path` string fields in place -
   * for stale-path relink (a file that moved but wasn't lost; see plan's
   * relink research). All-or-nothing: only applies if BOTH new strings
   * encode to no more bytes than the old ones currently occupy, so
   * nothing shifts and no other field's offset needs touching. Returns
   * false (no changes made) rather than truncating or overflowing into
   * adjacent row data when a new value doesn't fit - same "never guess,
   * never risk corruption for the sake of applying something" principle
   * as everywhere else in this project.
   */
  relinkTrackPath(trackId: number, newFilename: string, newPath: string): boolean {
    const locations = this.db.rowLocations(TableType.TRACKS)
    const tracks = this.db.tracks
    const idx = tracks.findIndex((t) => t.id === trackId)
    if (idx === -1) throw new Error(`no track with id ${trackId}`)
    const row = locations[idx]!

    const FILENAME_SLOT = 19
    const FILE_PATH_SLOT = 20
    const offsetsStart = row + 0x5e

    const filenameOff = row + this.buf.readUInt16LE(offsetsStart + FILENAME_SLOT * 2)
    const filePathOff = row + this.buf.readUInt16LE(offsetsStart + FILE_PATH_SLOT * 2)

    const oldFilenameBytes = stringByteLength(this.buf, filenameOff)
    const oldFilePathBytes = stringByteLength(this.buf, filePathOff)
    const newFilenameEnc = encodeString(newFilename)
    const newFilePathEnc = encodeString(newPath)

    if (newFilenameEnc.length > oldFilenameBytes || newFilePathEnc.length > oldFilePathBytes) {
      return false
    }

    newFilenameEnc.copy(this.buf, filenameOff)
    this.buf.fill(0, filenameOff + newFilenameEnc.length, filenameOff + oldFilenameBytes)
    newFilePathEnc.copy(this.buf, filePathOff)
    this.buf.fill(0, filePathOff + newFilePathEnc.length, filePathOff + oldFilePathBytes)

    this.invalidateDb()
    return true
  }

  // -- appending rows -------------------------------------------------------

  private slotCount(pageOff: number): number {
    return this.buf[pageOff + 0x18]! + 0x100 * (this.buf[pageOff + 0x19]! & 1)
  }

  private static dirBytes(n: number): number {
    return n ? 2 * n + 4 * Math.floor((n + 15) / 16) : 0
  }

  private markTableTouched(tableType: number, pageIndex: number): void {
    if (!this.newGen.has(tableType)) {
      const entry = this.tableEntryOffset(tableType)
      const first = this.buf.readUInt32LE(entry + 8)
      const last = this.buf.readUInt32LE(entry + 12)
      let gen = 0
      let page = first
      while (true) {
        gen = Math.max(gen, this.buf.readUInt32LE(page * this.pageSize + 0x10))
        if (page === last) break
        page = this.buf.readUInt32LE(page * this.pageSize + 0x0c)
      }
      this.newGen.set(tableType, gen + 1)
    }
    if (!this.touchedPages.has(tableType)) this.touchedPages.set(tableType, new Set())
    this.touchedPages.get(tableType)!.add(pageIndex)
    this.structural = true
  }

  /** Append one row to the end of a table, page bookkeeping included. */
  private appendRow(tableType: number, row: Buffer, alloc: number, indexShiftAt?: number): void {
    const maxAlloc = this.pageSize - PAGE_HEADER_SIZE - PdbEditor.dirBytes(1)
    if (alloc > maxAlloc) {
      throw new Error(`row allocation ${alloc} exceeds page capacity ${maxAlloc}`)
    }
    const entry = this.tableEntryOffset(tableType)
    let pageIndex = this.buf.readUInt32LE(entry + 12) // last_page
    let pageOff = pageIndex * this.pageSize

    if (this.buf[pageOff + 0x1b]! & 0x40) {
      // Empty table: its only page is the index page. Allocate.
      pageIndex = this.allocatePage(tableType)
      pageOff = pageIndex * this.pageSize
    }

    let n = this.slotCount(pageOff)
    let used = this.buf.readUInt16LE(pageOff + 0x1e)
    if (PAGE_HEADER_SIZE + used + alloc + PdbEditor.dirBytes(n + 1) > this.pageSize) {
      pageIndex = this.allocatePage(tableType)
      pageOff = pageIndex * this.pageSize
      n = 0
      used = 0
    }

    if (!this.origSlots.has(pageIndex)) {
      // First structural touch of this page in this session: reset the
      // written-this-save masks, exactly as a new rekordbox save does.
      this.origSlots.set(pageIndex, n)
      this.appends.set(pageIndex, 0)
      for (let group = 0; group < Math.floor((n + 15) / 16); group++) {
        this.buf.writeUInt16LE(0, pageOff + this.pageSize - group * 0x24 - 2)
      }
    }
    this.markTableTouched(tableType, pageIndex)

    const slot = n
    const group = Math.floor(slot / 16)
    const bit = slot % 16
    const groupBase = pageOff + this.pageSize - group * 0x24
    if (bit === 0) {
      // New row group: initialize its two flag words over heap garbage.
      this.buf.writeUInt16LE(0, groupBase - 4)
      this.buf.writeUInt16LE(0, groupBase - 2)
    }

    // Row bytes (zero-padded to the allocated size) into the heap.
    const rowStart = pageOff + PAGE_HEADER_SIZE + used
    row.copy(this.buf, rowStart)
    this.buf.fill(0, rowStart + row.length, rowStart + alloc)
    if (indexShiftAt !== undefined) {
      this.buf.writeUInt16LE(0x20 * slot, rowStart + indexShiftAt)
    }

    // Row directory: offset, presence bit, written-this-save bit.
    this.buf.writeUInt16LE(used, groupBase - 6 - 2 * bit)
    this.buf.writeUInt16LE(this.buf.readUInt16LE(groupBase - 4) | (1 << bit), groupBase - 4)
    this.buf.writeUInt16LE(this.buf.readUInt16LE(groupBase - 2) | (1 << bit), groupBase - 2)
    this.appends.set(pageIndex, this.appends.get(pageIndex)! + 1)

    // Page header bookkeeping.
    const newN = n + 1
    if (newN > 511) throw new Error('slot count encoding caps at 511 per page')
    const present = this.presentCount(pageOff, newN)
    this.buf[pageOff + 0x18] = newN & 0xff
    this.buf.writeUInt16LE(0x20 * present | (newN > 255 ? 1 : 0), pageOff + 0x19)
    used += alloc
    this.buf.writeUInt16LE(used, pageOff + 0x1e)
    this.buf.writeUInt16LE(this.pageSize - PAGE_HEADER_SIZE - used - PdbEditor.dirBytes(newN), pageOff + 0x1c)
    this.buf.writeUInt16LE(this.appends.get(pageIndex)!, pageOff + 0x20)
    this.buf.writeUInt16LE(this.origSlots.get(pageIndex)!, pageOff + 0x22)
    this.invalidateDb()
  }

  private presentCount(pageOff: number, n: number): number {
    let count = 0
    for (let group = 0; group < Math.floor((n + 15) / 16); group++) {
      const base = pageOff + this.pageSize - group * 0x24
      const inGroup = Math.min(16, n - group * 16)
      const flags = this.buf.readUInt16LE(base - 4) & ((1 << inGroup) - 1)
      count += popcount(flags)
    }
    return count
  }

  /** Turn the table's empty-candidate page into its new last page. */
  private allocatePage(tableType: number): number {
    const entry = this.tableEntryOffset(tableType)
    const newPage = this.buf.readUInt32LE(entry + 4) // empty_candidate
    const nextUnused = this.buf.readUInt32LE(12)

    const needed = (newPage + 1) * this.pageSize
    this.ensureCapacity(needed)

    const oldLast = this.buf.readUInt32LE(entry + 12)
    const pageOff = newPage * this.pageSize
    this.buf.fill(0, pageOff, pageOff + this.pageSize)
    this.buf.writeUInt32LE(newPage, pageOff + 0x04)
    this.buf.writeUInt32LE(tableType, pageOff + 0x08)
    this.buf.writeUInt32LE(nextUnused, pageOff + 0x0c) // -> new empty candidate
    this.buf[pageOff + 0x1b] = 0x24 // data page, no deletions
    this.buf.writeUInt16LE(this.pageSize - PAGE_HEADER_SIZE, pageOff + 0x1c)

    this.buf.writeUInt32LE(newPage, entry + 12) // table.last_page
    this.buf.writeUInt32LE(nextUnused, entry + 4) // table.empty_candidate
    this.buf.writeUInt32LE(nextUnused + 1, 12) // header next_unused_page

    if (this.buf[oldLast * this.pageSize + 0x1b]! & 0x40) {
      // First data page of a previously-empty table. Two separate things
      // need to point at it: the structural chain link (the index page's
      // own next_page, which markTableTouched()/parseTable() actually walk
      // - never previously written here, since every existing caller only
      // ever grows a table that already had at least one real page before
      // this ran) and the cosmetic "first data page" heap field FORMAT.md
      // documents real saves patching for the same case.
      this.buf.writeUInt32LE(newPage, oldLast * this.pageSize + 0x0c)
      const heap = oldLast * this.pageSize + PAGE_HEADER_SIZE
      if (this.buf.readUInt32LE(heap + 4) === 0x03ffffff) {
        this.buf.writeUInt32LE(newPage, heap + 4)
      }
    }

    this.origSlots.set(newPage, 0)
    this.appends.set(newPage, 0)
    this.markTableTouched(tableType, newPage)
    return newPage
  }

  private finalize(): void {
    for (const [tableType, pages] of this.touchedPages) {
      for (const page of pages) {
        this.buf.writeUInt32LE(this.newGen.get(tableType)!, page * this.pageSize + 0x10)
      }
    }
    if (this.structural) {
      // One editing session = one save transaction.
      if (this.finalSequence === undefined) {
        this.finalSequence = this.buf.readUInt32LE(0x14) + 1
      }
      this.buf.writeUInt32LE(this.finalSequence, 0x14)
    }
  }

  // -- lookup-table helpers -------------------------------------------------

  private getOrCreate(
    tableType: number,
    name: string,
    build: (id: number, name: string) => { row: Buffer; alloc: number; indexShiftAt?: number },
    // Real devices can hold multiple albums that share an identical name
    // (different artists' own "Best Of", "Remixes", etc. - confirmed on a
    // real 1293-track device: 23 such name collisions, each a genuinely
    // distinct album id). Matching on name alone silently merges them.
    // Genres/labels/keys have no such natural disambiguator and really are
    // one-per-name, so this only matters for callers that pass it.
    extraMatch?: (row: { id: number; name: string }) => boolean,
    // The source row's own id. Real players browse lookup tables by id (an
    // XDJ-700 v1.15 in the emulator showed a blank artist and skipped real
    // ones when artist ids were renumbered), so a rebuild keeps them.
    preferredId?: number
  ): number {
    for (const row of this.db.rows(tableType) as Array<{ id: number; name: string }>) {
      if (row.name === name && (!extraMatch || extraMatch(row))) return row.id
    }
    const existingIds = (this.db.rows(tableType) as Array<{ id: number }>).map((r) => r.id)
    const newId =
      preferredId && !existingIds.includes(preferredId)
        ? preferredId
        : (existingIds.length ? Math.max(...existingIds) : 0) + 1
    const built = build(newId, name)
    this.appendRow(tableType, built.row, built.alloc, built.indexShiftAt)
    return newId
  }

  /** Genre / label / history-playlist shape: u32 id + name. */
  private static buildNamedRow(rowId: number, name: string): { row: Buffer; alloc: number } {
    const s = encodeString(name)
    const idBuf = Buffer.alloc(4)
    idBuf.writeUInt32LE(rowId, 0)
    return { row: Buffer.concat([idBuf, s]), alloc: align4(4 + s.length) }
  }

  private static buildArtistRow(rowId: number, name: string): { row: Buffer; alloc: number; indexShiftAt: number } {
    const s = encodeString(name)
    // rekordbox packs short-ASCII names right after the header but starts
    // every long/UTF-16 name on a 4-byte boundary (0x0c, not 0x0a) - true
    // for all 107 UTF-16 artists on the real pristine device. An unaligned
    // UTF-16 name froze a real CDJ-2000NXS2 (M-Igashi/baken#168, confirmed
    // fixed on hardware by aligning it).
    const nameOff = isShortString(s) || REVERT_UTF16_ALIGN ? 10 : 12
    const alloc = align4(nameOff + align4(s.length)) + 4
    // Long names use subtype 0x64 with a u16 name offset at 0x0a (near
    // byte 0). The switch depends on the encoded name length, identically
    // for artists and albums: across 5 real exports names up to 214 bytes
    // stay 0x60/0x80 and names from 236 bytes are 0x64/0x84. The exact cut
    // between those two is unknown.
    const far = isLongName(s)
    const head = Buffer.alloc(far ? 12 : nameOff)
    head.writeUInt16LE(far ? 0x64 : 0x60, 0)
    head.writeUInt16LE(0, 2)
    head.writeUInt32LE(rowId, 4)
    head.writeUInt8(0x03, 8)
    if (far) head.writeUInt16LE(12, 0x0a)
    else head.writeUInt8(nameOff, 9)
    return { row: Buffer.concat([head, s]), alloc, indexShiftAt: 2 }
  }

  private static buildAlbumRow(
    rowId: number,
    name: string,
    artistId = 0
  ): { row: Buffer; alloc: number; indexShiftAt: number } {
    const s = encodeString(name)
    // Same alignment rule as buildArtistRow: long/UTF-16 names at 0x18, not 0x16.
    const nameOff = isShortString(s) || REVERT_UTF16_ALIGN ? 22 : 24
    const alloc = align4(nameOff + align4(s.length)) + 4
    // Long-name variant, same rule as buildArtistRow: subtype 0x84, u16 name
    // offset at 0x16 (confirmed on real exports with 236-468 byte names).
    const far = isLongName(s)
    const head = Buffer.alloc(far ? 24 : nameOff)
    head.writeUInt16LE(far ? 0x84 : 0x80, 0)
    head.writeUInt16LE(0, 2)
    head.writeUInt32LE(0, 4)
    head.writeUInt32LE(artistId, 8)
    head.writeUInt32LE(rowId, 12)
    head.writeUInt32LE(0, 16)
    head.writeUInt8(0x03, 20)
    if (far) head.writeUInt16LE(24, 0x16)
    else head.writeUInt8(nameOff, 21)
    return { row: Buffer.concat([head, s]), alloc, indexShiftAt: 2 }
  }

  private static buildKeyRow(rowId: number, name: string): { row: Buffer; alloc: number } {
    const s = encodeString(name)
    const head = Buffer.alloc(8)
    head.writeUInt32LE(rowId, 0)
    head.writeUInt32LE(rowId, 4)
    return { row: Buffer.concat([head, s]), alloc: align4(8 + s.length) }
  }

  getOrCreateArtist(name: string, preferredId?: number): number {
    return this.getOrCreate(TableType.ARTISTS, name, PdbEditor.buildArtistRow, undefined, preferredId)
  }

  getOrCreateAlbum(name: string, artistId = 0, preferredId?: number): number {
    return this.getOrCreate(
      TableType.ALBUMS,
      name,
      (id, n) => PdbEditor.buildAlbumRow(id, n, artistId),
      (row) => (row as Album).artistId === artistId,
      preferredId
    )
  }

  getOrCreateGenre(name: string, preferredId?: number): number {
    return this.getOrCreate(TableType.GENRES, name, PdbEditor.buildNamedRow, undefined, preferredId)
  }

  getOrCreateLabel(name: string, preferredId?: number): number {
    return this.getOrCreate(TableType.LABELS, name, PdbEditor.buildNamedRow, undefined, preferredId)
  }

  getOrCreateKey(name: string, preferredId?: number): number {
    return this.getOrCreate(TableType.KEYS, name, PdbEditor.buildKeyRow, undefined, preferredId)
  }

  // -- tracks -----------------------------------------------------------------

  /**
   * Add a track row; returns its id. Creates (or reuses) artist/album/
   * genre/key/label rows by name.
   *
   * Note: for the track to actually play on a CDJ, the audio file must
   * exist at filePath on the stick (and players expect ANLZ analysis
   * files at analyzePath).
   */
  addTrack(title: string, filePath: string, opts: AddTrackOptions = {}): number {
    const filename = opts.filename ?? filePath.split('/').pop()!
    const dateAdded = opts.dateAdded ?? new Date().toISOString().slice(0, 10)
    const sampleRate = opts.sampleRate ?? 44100
    const sampleDepth = opts.sampleDepth ?? 16
    const fileSize = opts.fileSize ?? 0
    const bitrate = opts.bitrate ?? 0
    const trackNumber = opts.trackNumber ?? 0
    const tempo = opts.tempo ?? 0
    const duration = opts.duration ?? 0
    const year = opts.year ?? 0
    const discNumber = opts.discNumber ?? 0
    const playCount = opts.playCount ?? 0
    const rating = opts.rating ?? 0
    const colorId = opts.colorId ?? 0
    const artworkId = opts.artworkId ?? 0
    const comment = opts.comment ?? ''
    const mixName = opts.mixName ?? ''
    const releaseDate = opts.releaseDate ?? ''
    const analyzePath = opts.analyzePath ?? ''
    const formatConst1 = opts.formatConst1 ?? 0xae49
    const formatConst2 = opts.formatConst2 ?? 0x03dd

    // Validate everything that can fail BEFORE creating lookup rows, so a
    // bad argument can't leave orphan artist/album/... rows.
    for (const [name, value, size] of [
      ['sample_rate', sampleRate, 4],
      ['file_size', fileSize, 4],
      ['bitrate', bitrate, 4],
      ['track_number', trackNumber, 4],
      ['tempo', tempo, 4],
      ['disc_number', discNumber, 2],
      ['play_count', playCount, 2],
      ['year', year, 2],
      ['sample_depth', sampleDepth, 2],
      ['duration', duration, 2],
      ['artwork_id', artworkId, 4],
      ['color_id', colorId, 1],
      ['rating', rating, 1]
    ] as const) {
      checkRange(name, value, size)
    }

    const strings = [
      '',
      '',
      '2',
      '2',
      '', // 0-4 (0 = ISRC, left empty)
      '',
      'ON',
      'ON',
      '',
      '', // 5-9 (kuvo_public, autoload_hotcues)
      dateAdded,
      releaseDate,
      mixName,
      '',
      analyzePath,
      dateAdded, // 14-15 (analyze_date)
      comment,
      title,
      '',
      filename,
      filePath
    ]
    const encoded = strings.map((s, i) =>
      opts.rawStrings?.[i] && RAW_STRING_SLOTS.includes(i) ? opts.rawStrings[i]! : encodeString(s)
    )
    const alloc = 0x88 + encoded.reduce((sum, e) => sum + align4(e.length), 0) + 4
    const maxAlloc = this.pageSize - PAGE_HEADER_SIZE - PdbEditor.dirBytes(1)
    if (alloc > maxAlloc) throw new Error('track row too large for one page')

    const artistId = opts.artist ? this.getOrCreateArtist(opts.artist) : 0
    const composerId = opts.composer ? this.getOrCreateArtist(opts.composer) : 0
    const originalArtistId = opts.originalArtist ? this.getOrCreateArtist(opts.originalArtist) : 0
    const remixerId = opts.remixer ? this.getOrCreateArtist(opts.remixer) : 0
    // '' means "this album genuinely has no artist" (use 0, not the
    // track's own artist); undefined means "no data provided" (fall back
    // to the track's own artist, the old behavior) - see AddTrackOptions.
    const albumArtistId =
      opts.albumArtist !== undefined ? (opts.albumArtist ? this.getOrCreateArtist(opts.albumArtist) : 0) : artistId
    const albumId = opts.album ? this.getOrCreateAlbum(opts.album, albumArtistId) : 0
    const genreId = opts.genre ? this.getOrCreateGenre(opts.genre) : 0
    const keyId = opts.key ? this.getOrCreateKey(opts.key) : 0
    const labelId = opts.label ? this.getOrCreateLabel(opts.label) : 0

    const existingTrackIds = this.db.tracks.map((t) => t.id)
    if (opts.id !== undefined && existingTrackIds.includes(opts.id)) throw new Error(`track id ${opts.id} already exists`)
    const trackId = opts.id ?? (existingTrackIds.length ? Math.max(...existingTrackIds) : 0) + 1

    // Unique per-track value at 0x14 (purpose unknown; unique in every
    // real export, so keep it unique here too).
    const seen = new Set(this.db.rowLocations(TableType.TRACKS).map((loc) => this.buf.readUInt32LE(loc + 0x14)))
    const unique = opts.masterContentId ?? (seen.size ? Math.max(...seen) : 0x00100000) + 1

    const dotIndex = filePath.lastIndexOf('.')
    const ext = dotIndex >= 0 ? filePath.slice(dotIndex).toLowerCase() : ''
    const fileType = FILE_TYPE_CODES[ext] ?? 0x01

    const fixed = Buffer.alloc(0x5e)
    fixed.writeUInt16LE(0x0024, 0x00) // magic
    fixed.writeUInt16LE(0, 0x02) // index_shift (patched on append)
    fixed.writeUInt32LE(0x000c0700, 0x04) // bitmask (constant in every export)
    fixed.writeUInt32LE(sampleRate, 0x08)
    fixed.writeUInt32LE(composerId, 0x0c)
    fixed.writeUInt32LE(fileSize, 0x10)
    fixed.writeUInt32LE(unique, 0x14)
    fixed.writeUInt16LE(formatConst1, 0x18)
    fixed.writeUInt16LE(formatConst2, 0x1a)
    fixed.writeUInt32LE(artworkId, 0x1c)
    fixed.writeUInt32LE(keyId, 0x20)
    fixed.writeUInt32LE(originalArtistId, 0x24)
    fixed.writeUInt32LE(labelId, 0x28)
    fixed.writeUInt32LE(remixerId, 0x2c)
    fixed.writeUInt32LE(bitrate, 0x30)
    fixed.writeUInt32LE(trackNumber, 0x34)
    fixed.writeUInt32LE(tempo, 0x38)
    fixed.writeUInt32LE(genreId, 0x3c)
    fixed.writeUInt32LE(albumId, 0x40)
    fixed.writeUInt32LE(artistId, 0x44)
    fixed.writeUInt32LE(trackId, 0x48)
    fixed.writeUInt16LE(discNumber, 0x4c)
    fixed.writeUInt16LE(playCount, 0x4e)
    fixed.writeUInt16LE(year, 0x50)
    fixed.writeUInt16LE(sampleDepth, 0x52)
    fixed.writeUInt16LE(duration, 0x54)
    fixed.writeUInt16LE(0x0029, 0x56) // unknown constant
    fixed.writeUInt8(colorId, 0x58)
    fixed.writeUInt8(rating, 0x59)
    fixed.writeUInt16LE(fileType, 0x5a)
    fixed.writeUInt16LE(0x0003, 0x5c)

    const offsets: number[] = []
    const blobParts: Buffer[] = []
    let pos = 0x88
    for (const enc of encoded) {
      if (!REVERT_UTF16_ALIGN && (enc[0]! & 1) === 0 && pos % 4) {
        // long strings start 4-aligned
        const pad = 4 - (pos % 4)
        blobParts.push(Buffer.alloc(pad))
        pos += pad
      }
      offsets.push(pos)
      blobParts.push(enc)
      pos += enc.length
    }
    const offsetsBuf = Buffer.alloc(42)
    offsets.forEach((o, i) => offsetsBuf.writeUInt16LE(o, i * 2))

    const row = Buffer.concat([fixed, offsetsBuf, ...blobParts])
    this.appendRow(TableType.TRACKS, row, alloc, 2)
    return trackId
  }

  // -- playlists ----------------------------------------------------------------

  createPlaylist(name: string, parentId = 0, isFolder = false, sortOrder?: number, id?: number): number {
    const nodes = this.db.playlistTree
    if (id !== undefined && nodes.some((n) => n.id === id)) throw new Error(`playlist id ${id} already exists`)
    const nodeId = id ?? (nodes.length ? Math.max(...nodes.map((n) => n.id)) : 0) + 1
    if (sortOrder === undefined) {
      const siblingOrders = nodes.filter((n) => n.parentId === parentId).map((n) => n.sortOrder)
      sortOrder = (siblingOrders.length ? Math.max(...siblingOrders) : -1) + 1
    }
    const s = encodeString(name)
    const head = Buffer.alloc(20)
    head.writeUInt32LE(parentId, 0)
    head.writeUInt32LE(0, 4)
    head.writeUInt32LE(sortOrder, 8)
    head.writeUInt32LE(nodeId, 12)
    head.writeUInt32LE(isFolder ? 1 : 0, 16)
    this.appendRow(TableType.PLAYLIST_TREE, Buffer.concat([head, s]), align4(20 + s.length))
    return nodeId
  }

  addToPlaylist(playlistId: number, trackId: number, entryIndex?: number): void {
    const node = this.db.playlistTree.find((n) => n.id === playlistId)
    if (!node || node.isFolder) throw new Error(`no playlist with id ${playlistId}`)
    let index = entryIndex
    if (index === undefined) {
      const existing = this.db.playlistEntries.filter((e) => e.playlistId === playlistId).map((e) => e.entryIndex)
      index = (existing.length ? Math.max(...existing) : 0) + 1
    }
    const row = Buffer.alloc(12)
    row.writeUInt32LE(index, 0)
    row.writeUInt32LE(trackId, 4)
    row.writeUInt32LE(playlistId, 8)
    this.appendRow(TableType.PLAYLIST_ENTRIES, row, 12)
  }
}

function popcount(n: number): number {
  let count = 0
  let x = n
  while (x) {
    count += x & 1
    x >>= 1
  }
  return count
}
