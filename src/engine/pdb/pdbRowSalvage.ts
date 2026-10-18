/**
 * Row-level salvage within a single pdb page - plan §1, §3, Phase 2/3.
 *
 * Rows are stored in groups of up to 16 within a page, each with a
 * presence/transaction bitmask - so a partially-damaged page doesn't
 * necessarily lose every row in it. Reuses the exact row-group walk and
 * per-table row parsers the normal chain-walking reader uses
 * (pdbReader.ts), so a salvaged row is decoded identically to how a
 * healthy read would have produced it.
 */
import type { ScannedPage } from './pdbPageScanner'
import { rowOffsetsForPage, ROW_PARSERS } from './pdbReader'

export interface SalvagedRow {
  pageIndex: number
  /** Absolute-within-page offset, same convention as pdbReader's rowLocations. */
  rowOffset: number
  tableType: number
  parsed: unknown
}

/**
 * Deliberately different from pdbReader.ts's parseTable: a single garbled
 * row (e.g. a string offset pointing outside the page) is skipped, not
 * treated as fatal to the whole page - maximizing partial recovery is the
 * entire point of standalone salvage, unlike the normal reader, which
 * reports one error for the rest of a table once any row throws.
 */
export function salvageRowsFromPage(page: ScannedPage): SalvagedRow[] {
  if (page.isIndexPage) return []
  const parser = ROW_PARSERS[page.tableType as keyof typeof ROW_PARSERS]
  if (!parser) return []

  const rows: SalvagedRow[] = []
  for (const rowOffset of rowOffsetsForPage(page.data, page.data.length)) {
    try {
      rows.push({ pageIndex: page.index, rowOffset, tableType: page.tableType, parsed: parser(page.data, rowOffset) })
    } catch {
      // One garbled row - keep salvaging the rest of the page.
    }
  }
  return rows
}
