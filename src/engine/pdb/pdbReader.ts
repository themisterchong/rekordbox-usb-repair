/**
 * Ported from fragmede/rekordbox-pdb (MIT License, Copyright (c) 2026 fragmede)
 * https://github.com/fragmede/rekordbox-pdb - src/rekordbox_pdb/pdb.py
 * Verified byte-by-byte against real exports; see that repo's FORMAT.md.
 *
 * Layout:
 * - The file is an array of fixed-size pages (4096 bytes in every export seen).
 * - The file header (page 0) holds the page size and a table directory:
 *   one (type, empty_candidate, first_page, last_page) entry per table.
 * - Each table is a linked list of pages, first_page..last_page, chained by
 *   the next_page field of each page header.
 * - Pages whose flags have bit 0x40 set hold no rows; data pages keep row
 *   data in a heap growing up from offset 0x28, and row offsets in groups
 *   of up to 16 growing down from the page end (0x24 bytes per group: 16
 *   u16 offsets, a u16 presence bitmask at group_base - 4).
 */
import { PAGE_HEADER_SIZE, ROW_GROUP_SIZE, TableType, ExtTableType } from './pdbConstants'
import { decodeString } from './pdbStrings'

export { TableType, ExtTableType }

export interface PdbTable {
  type: number
  emptyCandidate: number
  firstPage: number
  lastPage: number
}

// -- Row types ---------------------------------------------------------------

/** Names of the 21 track string slots, in file order. */
export const TRACK_STRING_NAMES = [
  'unknown_string_1',
  'texter',
  'unknown_string_2',
  'unknown_string_3',
  'unknown_string_4',
  'message',
  'kuvo_public',
  'autoload_hotcues',
  'unknown_string_5',
  'unknown_string_6',
  'date_added',
  'release_date',
  'mix_name',
  'unknown_string_7',
  'analyze_path',
  'analyze_date',
  'comment',
  'title',
  'unknown_string_8',
  'filename',
  'file_path'
] as const

export interface Track {
  indexShift: number
  bitmask: number
  sampleRate: number
  composerId: number
  fileSize: number
  // MASTERCONTENTID at 0x14 (named in the XDJ-700 1.15 firmware; equals
  // exportLibrary.db content.masterContentId - see chrisle/rbxport#383).
  // Carried through verbatim on rebuild.
  masterContentId: number
  // Raw bytes at 0x18/0x1a - documented by fragmede/rekordbox-pdb's FORMAT.md
  // as "constant" (0xAE49/0x03DD), but a real 1293-track device export shows
  // they vary (3 distinct value-pairs, uncorrelated with file format/bitrate/
  // sample rate) - most likely a per-Rekordbox-version write stamp. Carried
  // through verbatim on rebuild instead of hardcoded, same as `unique`.
  formatConst1: number
  formatConst2: number
  artworkId: number
  keyId: number
  originalArtistId: number
  labelId: number
  remixerId: number
  bitrate: number
  trackNumber: number
  tempo: number // BPM * 100
  genreId: number
  albumId: number
  artistId: number
  id: number
  discNumber: number
  playCount: number
  year: number
  sampleDepth: number
  duration: number // seconds
  colorId: number
  rating: number
  strings: string[] // the 21 string slots, in file order
  // The same 21 slots as their exact encoded bytes. Needed to carry slots
  // through a rebuild verbatim: ISRC (slot 0) uses a rekordbox-specific
  // encoding (0x90 header, then 0x03 + ASCII + NUL) that decodeString()
  // can't round-trip.
  rawStrings: Buffer[]
  // Named accessors for the string slots that matter, matching the
  // reference implementation's @property getters (indices per
  // TRACK_STRING_NAMES) - kept as plain computed-once fields rather than
  // getters since this is a plain parsed data object.
  message: string
  dateAdded: string
  releaseDate: string
  mixName: string
  analyzePath: string
  analyzeDate: string
  comment: string
  title: string
  filename: string
  filePath: string
}

export interface Genre {
  id: number
  name: string
}
export type Label = Genre

export interface Artist {
  id: number
  name: string
  indexShift: number
}

export interface Album {
  id: number
  name: string
  artistId: number
  indexShift: number
}

export interface Key {
  id: number
  name: string
}

export interface Color {
  id: number
  name: string
}

export interface PlaylistTreeNode {
  id: number
  parentId: number
  sortOrder: number
  name: string
  isFolder: boolean
}

export interface PlaylistEntry {
  entryIndex: number
  trackId: number
  playlistId: number
}

export interface Artwork {
  id: number
  path: string
}

export interface Column {
  id: number
  name: string
}

export type HistoryPlaylist = Genre

export interface HistoryEntry {
  trackId: number
  playlistId: number
  entryIndex: number
}

export interface Tag {
  id: number
  name: string
  categoryId: number
  position: number
  isCategory: boolean
  indexShift: number
}

export interface UnknownRow {
  pageIndex: number
  offset: number
}

// -- Row parsers ---------------------------------------------------------------
// `page` is a Buffer view of exactly one 4096-byte page; `row` is an offset
// within it (the start of this row's bytes, i.e. PAGE_HEADER_SIZE-relative
// offsets already resolved to absolute-within-page).

function parseTrack(page: Buffer, row: number): Track {
  // Fixed row header: 0x5E bytes, exact field offsets verified against
  // fragmede/rekordbox-pdb's _TRACK_FIXED struct and TRACK_FIXED_FIELDS.
  const indexShift = page.readUInt16LE(row + 2)
  const bitmask = page.readUInt32LE(row + 4)
  const sampleRate = page.readUInt32LE(row + 8)
  const composerId = page.readUInt32LE(row + 0xc)
  const fileSize = page.readUInt32LE(row + 0x10)
  const masterContentId = page.readUInt32LE(row + 0x14)
  const formatConst1 = page.readUInt16LE(row + 0x18)
  const formatConst2 = page.readUInt16LE(row + 0x1a)
  const artworkId = page.readUInt32LE(row + 0x1c)
  const keyId = page.readUInt32LE(row + 0x20)
  const originalArtistId = page.readUInt32LE(row + 0x24)
  const labelId = page.readUInt32LE(row + 0x28)
  const remixerId = page.readUInt32LE(row + 0x2c)
  const bitrate = page.readUInt32LE(row + 0x30)
  const trackNumber = page.readUInt32LE(row + 0x34)
  const tempo = page.readUInt32LE(row + 0x38)
  const genreId = page.readUInt32LE(row + 0x3c)
  const albumId = page.readUInt32LE(row + 0x40)
  const artistId = page.readUInt32LE(row + 0x44)
  const id = page.readUInt32LE(row + 0x48)
  const discNumber = page.readUInt16LE(row + 0x4c)
  const playCount = page.readUInt16LE(row + 0x4e)
  const year = page.readUInt16LE(row + 0x50)
  const sampleDepth = page.readUInt16LE(row + 0x52)
  const duration = page.readUInt16LE(row + 0x54)
  const colorId = page.readUInt8(row + 0x58)
  const rating = page.readUInt8(row + 0x59)

  const stringsStart = row + 0x5e // PAGE_HEADER_SIZE-relative fixed size (0x5E)
  const offsets: number[] = []
  for (let i = 0; i < 21; i++) {
    offsets.push(page.readUInt16LE(stringsStart + i * 2))
  }
  const strings = offsets.map((o) => decodeString(page, row + o))
  const rawStrings = offsets.map((o) => {
    const start = row + o
    const flag = page.readUInt8(start)
    const len = flag & 1 ? flag >> 1 : page.readUInt16LE(start + 1)
    return Buffer.from(page.subarray(start, start + len))
  })

  return {
    indexShift,
    bitmask,
    sampleRate,
    composerId,
    fileSize,
    masterContentId,
    formatConst1,
    formatConst2,
    artworkId,
    keyId,
    originalArtistId,
    labelId,
    remixerId,
    bitrate,
    trackNumber,
    tempo,
    genreId,
    albumId,
    artistId,
    id,
    discNumber,
    playCount,
    year,
    sampleDepth,
    duration,
    colorId,
    rating,
    strings,
    rawStrings,
    message: strings[5]!,
    dateAdded: strings[10]!,
    releaseDate: strings[11]!,
    mixName: strings[12]!,
    analyzePath: strings[14]!,
    analyzeDate: strings[15]!,
    comment: strings[16]!,
    title: strings[17]!,
    filename: strings[19]!,
    filePath: strings[20]!
  }
}

function parseGenreOrLabel(page: Buffer, row: number): Genre {
  return { id: page.readUInt32LE(row), name: decodeString(page, row + 4) }
}

function parseArtist(page: Buffer, row: number): Artist {
  const subtype = page.readUInt16LE(row)
  const indexShift = page.readUInt16LE(row + 2)
  const id = page.readUInt32LE(row + 4)
  const nameOffset = subtype === 0x64 ? page.readUInt16LE(row + 0x0a) : page.readUInt8(row + 9)
  return { id, name: decodeString(page, row + nameOffset), indexShift }
}

function parseAlbum(page: Buffer, row: number): Album {
  const indexShift = page.readUInt16LE(row + 2)
  const artistId = page.readUInt32LE(row + 8)
  const id = page.readUInt32LE(row + 12)
  // Subtype 0x84 is the long-row variant with a u16 name offset at 0x16,
  // mirroring artists' 0x64.
  const nameOffset = page.readUInt16LE(row) === 0x84 ? page.readUInt16LE(row + 0x16) : page.readUInt8(row + 0x15)
  return { id, name: decodeString(page, row + nameOffset), artistId, indexShift }
}

function parseKey(page: Buffer, row: number): Key {
  return { id: page.readUInt32LE(row), name: decodeString(page, row + 8) }
}

function parseColor(page: Buffer, row: number): Color {
  return { id: page.readUInt16LE(row + 5), name: decodeString(page, row + 8) }
}

function parsePlaylistTreeNode(page: Buffer, row: number): PlaylistTreeNode {
  return {
    parentId: page.readUInt32LE(row),
    sortOrder: page.readUInt32LE(row + 8),
    id: page.readUInt32LE(row + 12),
    isFolder: page.readUInt32LE(row + 16) !== 0,
    name: decodeString(page, row + 20)
  }
}

function parsePlaylistEntry(page: Buffer, row: number): PlaylistEntry {
  return {
    entryIndex: page.readUInt32LE(row),
    trackId: page.readUInt32LE(row + 4),
    playlistId: page.readUInt32LE(row + 8)
  }
}

function parseArtwork(page: Buffer, row: number): Artwork {
  return { id: page.readUInt32LE(row), path: decodeString(page, row + 4) }
}

function parseColumn(page: Buffer, row: number): Column {
  return { id: page.readUInt16LE(row), name: decodeString(page, row + 4) }
}

function parseHistoryEntry(page: Buffer, row: number): HistoryEntry {
  return {
    trackId: page.readUInt32LE(row),
    playlistId: page.readUInt32LE(row + 4),
    entryIndex: page.readUInt32LE(row + 8)
  }
}

function parseTag(page: Buffer, row: number): Tag {
  return {
    indexShift: page.readUInt16LE(row + 2),
    categoryId: page.readUInt32LE(row + 0x0c),
    position: page.readUInt32LE(row + 0x10),
    id: page.readUInt32LE(row + 0x14),
    isCategory: page.readUInt8(row + 0x1b) !== 0,
    name: decodeString(page, row + page.readUInt8(row + 0x1d))
  }
}

export type RowParser = (page: Buffer, row: number) => unknown

/**
 * Exported (not just internal to PdbFile) so standalone page-scan salvage
 * (pdbRowSalvage.ts) can decode a row the exact same way the normal
 * chain-walking reader does, without duplicating the table->parser mapping.
 */
export const ROW_PARSERS: Partial<Record<TableType, RowParser>> = {
  [TableType.TRACKS]: parseTrack,
  [TableType.GENRES]: parseGenreOrLabel,
  [TableType.ARTISTS]: parseArtist,
  [TableType.ALBUMS]: parseAlbum,
  [TableType.LABELS]: parseGenreOrLabel,
  [TableType.KEYS]: parseKey,
  [TableType.COLORS]: parseColor,
  [TableType.PLAYLIST_TREE]: parsePlaylistTreeNode,
  [TableType.PLAYLIST_ENTRIES]: parsePlaylistEntry,
  [TableType.ARTWORK]: parseArtwork,
  [TableType.COLUMNS]: parseColumn,
  [TableType.HISTORY_PLAYLISTS]: parseGenreOrLabel,
  [TableType.HISTORY_ENTRIES]: parseHistoryEntry
}

const EXT_ROW_PARSERS: Partial<Record<ExtTableType, RowParser>> = {
  [ExtTableType.TAGS]: parseTag
}

// -- Container -----------------------------------------------------------------

/** Shared DeviceSQL container logic for export.pdb / exportExt.pdb. */
export class PdbFile {
  readonly pageSize: number
  readonly tables: PdbTable[]
  private readonly data: Buffer
  private readonly rowParsers: Partial<Record<number, RowParser>>
  private readonly rowsByType = new Map<number, unknown[]>()
  private readonly locationsByType = new Map<number, number[]>()

  constructor(data: Buffer, rowParsers: Partial<Record<number, RowParser>>) {
    this.data = data
    this.rowParsers = rowParsers
    this.pageSize = data.readUInt32LE(4)
    const numTables = data.readUInt32LE(8)
    this.tables = []
    for (let i = 0; i < numTables; i++) {
      const off = 0x1c + i * 16
      this.tables.push({
        type: data.readUInt32LE(off),
        emptyCandidate: data.readUInt32LE(off + 4),
        firstPage: data.readUInt32LE(off + 8),
        lastPage: data.readUInt32LE(off + 12)
      })
    }
    for (const table of this.tables) {
      const [rows, locations, error] = this.parseTable(table)
      this.rowsByType.set(table.type, rows)
      this.locationsByType.set(table.type, locations)
      if (error) this.tableErrors.set(table.type, error)
    }
  }

  /**
   * Per-table parse errors, keyed by table type - set when a table's page
   * chain runs into missing/corrupted pages partway through (this is a real
   * repair tool reading potentially-damaged files, not just healthy ones,
   * so one broken table must not prevent reading the others). rows()/
   * rowLocations() for that table still return whatever was successfully
   * read before the failure.
   */
  readonly tableErrors = new Map<number, string>()

  rows(tableType: number): unknown[] {
    return this.rowsByType.get(tableType) ?? []
  }

  /** Absolute file offset of each row, parallel to rows(). */
  rowLocations(tableType: number): number[] {
    return this.locationsByType.get(tableType) ?? []
  }

  private page(index: number): Buffer {
    const start = index * this.pageSize
    return this.data.subarray(start, start + this.pageSize)
  }

  private parseTable(table: PdbTable): [unknown[], number[], string | undefined] {
    const parser = this.rowParsers[table.type]
    const rows: unknown[] = []
    const locations: number[] = []
    let pageIndex = table.firstPage
    // Guard against a malformed/circular chain looping forever - not
    // something a healthy file should ever do, but this reader also runs
    // against corrupted input.
    const visited = new Set<number>()
    try {
      while (true) {
        if (visited.has(pageIndex)) {
          return [rows, locations, `page chain loops back to already-visited page ${pageIndex}`]
        }
        visited.add(pageIndex)
        const page = this.page(pageIndex)
        if (page.length < this.pageSize) {
          // The file ends before this page does - exactly the "unsafe
          // eject mid-write" truncation signature this tool exists to
          // handle (plan §1). Stop here with whatever was read so far.
          return [rows, locations, `page ${pageIndex} is missing (file truncated before it)`]
        }
        for (const rowOffset of rowOffsetsForPage(page, this.pageSize)) {
          const parsed = parser ? parser(page, rowOffset) : ({ pageIndex, offset: rowOffset } satisfies UnknownRow)
          rows.push(parsed)
          locations.push(pageIndex * this.pageSize + rowOffset)
        }
        if (pageIndex === table.lastPage) break
        pageIndex = page.readUInt32LE(12) // next_page
      }
      return [rows, locations, undefined]
    } catch (err) {
      // A row parser can still throw on a page that exists but is garbled
      // (not merely missing) - e.g. a string offset pointing outside the
      // page. Same handling: keep what was salvaged, note the failure.
      const message = err instanceof Error ? err.message : String(err)
      return [rows, locations, `failed while reading page ${pageIndex}: ${message}`]
    }
  }

}

/**
 * Offsets (within the page) of all present rows on a data page. Exported
 * (not just internal to PdbFile) so standalone page-scan salvage
 * (pdbRowSalvage.ts) can reuse this exact row-group/presence-bitmask walk
 * instead of reimplementing it against a page whose table membership the
 * broken directory/chain can no longer vouch for.
 */
export function rowOffsetsForPage(page: Buffer, pageSize: number): number[] {
  const pageFlags = page[27]
  if (pageFlags === undefined || pageFlags & 0x40) return [] // not a data page
  // Slot count n is stored as n & 0xFF at 0x18 plus an overflow bit (bit 0
  // of the byte at 0x19, whose upper bits hold 0x20 * the number of
  // present rows). The often-cited heuristic based on the byte at 0x22
  // under-reads pages that ever exceeded 255 slots; that field is really
  // the slot count at the previous write.
  const b24 = page[24] ?? 0
  const b25 = page[25] ?? 0
  const numRows = b24 + 0x100 * (b25 & 1)
  if (numRows === 0) return []
  const offsets: number[] = []
  const numGroups = Math.floor((numRows - 1) / 16) + 1
  for (let group = 0; group < numGroups; group++) {
    const base = pageSize - group * ROW_GROUP_SIZE
    const presentFlags = page.readUInt16LE(base - 4)
    const inGroup = group < numGroups - 1 ? 16 : ((numRows - 1) % 16) + 1
    for (let i = 0; i < inGroup; i++) {
      if ((presentFlags >> i) & 1) {
        offsets.push(PAGE_HEADER_SIZE + page.readUInt16LE(base - 6 - 2 * i))
      }
    }
  }
  return offsets
}

/** A parsed export.pdb file. */
export class Database extends PdbFile {
  constructor(data: Buffer) {
    super(data, ROW_PARSERS)
  }

  get tracks(): Track[] {
    return this.rows(TableType.TRACKS) as Track[]
  }
  get genres(): Genre[] {
    return this.rows(TableType.GENRES) as Genre[]
  }
  get artists(): Artist[] {
    return this.rows(TableType.ARTISTS) as Artist[]
  }
  get albums(): Album[] {
    return this.rows(TableType.ALBUMS) as Album[]
  }
  get labels(): Label[] {
    return this.rows(TableType.LABELS) as Label[]
  }
  get keys(): Key[] {
    return this.rows(TableType.KEYS) as Key[]
  }
  get colors(): Color[] {
    return this.rows(TableType.COLORS) as Color[]
  }
  get playlistTree(): PlaylistTreeNode[] {
    return this.rows(TableType.PLAYLIST_TREE) as PlaylistTreeNode[]
  }
  get playlistEntries(): PlaylistEntry[] {
    return this.rows(TableType.PLAYLIST_ENTRIES) as PlaylistEntry[]
  }
  get artwork(): Artwork[] {
    return this.rows(TableType.ARTWORK) as Artwork[]
  }
  get columns(): Column[] {
    return this.rows(TableType.COLUMNS) as Column[]
  }
  get historyPlaylists(): HistoryPlaylist[] {
    return this.rows(TableType.HISTORY_PLAYLISTS) as HistoryPlaylist[]
  }
  get historyEntries(): HistoryEntry[] {
    return this.rows(TableType.HISTORY_ENTRIES) as HistoryEntry[]
  }
}

/** A parsed exportExt.pdb file (My Tag data). */
export class ExtDatabase extends PdbFile {
  constructor(data: Buffer) {
    super(data, EXT_ROW_PARSERS)
  }

  get tags(): Tag[] {
    return this.rows(ExtTableType.TAGS) as Tag[]
  }
}
