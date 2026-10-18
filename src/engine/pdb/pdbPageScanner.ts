/**
 * Legacy `export.pdb` ("DeviceSQL") page-scan salvage - plan §1, §3, Phase 2/3.
 *
 * Reference:
 * github.com/Deep-Symmetry/crate-digger (rekordbox_pdb.ksy, doc/Analysis.pdf)
 * github.com/fragmede/rekordbox-pdb (FORMAT.md - primary reference for write mechanics)
 *
 * Strategy: don't trust the master pointer table - every page carries its
 * own embedded table-type marker in its header (offset 0x08, confirmed
 * against FORMAT.md and against pdbEditor.ts's own write path,
 * allocatePage(), which stamps exactly this field), so a linear scan of
 * every 4096-byte page can reconstruct per-table page groupings even when
 * the header/pointer section is damaged.
 */
import { TableType } from './pdbConstants'

export const PDB_PAGE_SIZE = 4096

export interface ScannedPage {
  /** Byte offset of this page within the file. */
  offset: number
  /** Page index (offset / pageSize). */
  index: number
  /** Whether this page's header parsed as structurally plausible. */
  readable: boolean
  tableType: number
  /** Index/empty page (flags bit 0x40 set) vs. a real data page. */
  isIndexPage: boolean
  /** Raw page bytes, for downstream row salvage. */
  data: Buffer
}

export interface PageScanResult {
  pageSize: number
  totalPages: number
  readablePages: number
  unreadablePages: number
  /** Bytes past the last whole page, if the file was truncated mid-page. */
  truncatedTailBytes: number
  pagesByTable: Map<number, ScannedPage[]>
  /**
   * File header offset 0x10 (u32), preserved from the original if the
   * header itself survived - confirmed non-zero and required on a real
   * device (value 5 observed), but its meaning is unidentified. Page 0
   * sits at the very start of the file, so it almost always survives even
   * when data pages later on don't - preserving it costs nothing and, per
   * the same logic as reusing original index pages, is safer than
   * guessing a value for a field we don't understand.
   */
  originalHeaderField0x10: number
}

const PLAUSIBLE_FLAGS = new Set([0x24, 0x34, 0x64])

/**
 * Linearly scan every page in a (possibly corrupted) pdb buffer and group
 * pages by their own embedded table-type marker, independent of whatever's
 * broken in the master pointer table at the front of the file.
 */
export function scanPdbPages(buffer: Buffer): PageScanResult {
  // The file header (page 0) might itself be corrupted - fall back to the
  // one page size ever seen in a real export rather than trusting a
  // possibly-garbage value that could turn every subsequent page boundary
  // calculation into nonsense.
  let pageSize = buffer.readUInt32LE(4)
  if (!(pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0)) {
    pageSize = PDB_PAGE_SIZE
  }

  const totalPages = Math.floor(buffer.length / pageSize)
  const truncatedTailBytes = buffer.length - totalPages * pageSize
  const pagesByTable = new Map<number, ScannedPage[]>()
  let readablePages = 0
  let unreadablePages = 0
  const originalHeaderField0x10 = buffer.length >= 0x14 ? buffer.readUInt32LE(0x10) : 0

  // Page 0 is always the file header/table directory, never a generic page
  // - its own offset 0x08 is numTables, not a table-type marker, so
  // deliberately never treat it as scannable data.
  for (let index = 1; index < totalPages; index++) {
    const offset = index * pageSize
    const data = buffer.subarray(offset, offset + pageSize)
    const selfIndex = data.readUInt32LE(0x04)
    const tableType = data.readUInt32LE(0x08)
    const flags = data[0x1b]
    const readable = selfIndex === index && tableType <= TableType.HISTORY && flags !== undefined && PLAUSIBLE_FLAGS.has(flags)

    if (readable) {
      readablePages++
      const isIndexPage = (flags! & 0x40) !== 0
      const page: ScannedPage = { offset, index, readable, tableType, isIndexPage, data }
      const bucket = pagesByTable.get(tableType)
      if (bucket) bucket.push(page)
      else pagesByTable.set(tableType, [page])
    } else {
      unreadablePages++
    }
  }

  return { pageSize, totalPages, readablePages, unreadablePages, truncatedTailBytes, pagesByTable, originalHeaderField0x10 }
}
