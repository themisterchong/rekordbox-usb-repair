/**
 * CDJ/XDJ safety checks on an export.pdb that a desktop parser doesn't catch.
 *
 * Misaligned long strings: every long-ASCII (0x40) and UTF-16 (0x90) DeviceSQL string must start
 * on a 4-byte boundary of the file. rekordbox always writes them that way. A misaligned one freezes
 * the XDJ-700 v1.15 on insert or at the "MY SETTINGS DATA was found" prompt (reproduced on the real
 * firmware in emulation, 2026-10-17), and froze a CDJ-2000NXS2 in M-Igashi/baken#168. Short ASCII
 * strings (odd kind byte) have no alignment rule.
 */
import { Database, TableType } from './pdbReader'

export interface MisalignedReport {
  total: number
  byTable: Record<string, number>
  /** A few examples (decoded text), for the UI and logs. */
  examples: string[]
}

function isLongString(buf: Buffer, at: number): boolean {
  const kind = buf[at]
  return kind === 0x40 || kind === 0x90
}

function decode(buf: Buffer, at: number): string {
  const kind = buf[at]
  const total = buf.readUInt16LE(at + 1)
  return kind === 0x90 ? buf.toString('utf16le', at + 4, at + total) : buf.toString('latin1', at + 4, at + total)
}

export function findMisalignedStrings(buf: Buffer, db: Database): MisalignedReport {
  const report: MisalignedReport = { total: 0, byTable: {}, examples: [] }
  const check = (table: string, at: number): void => {
    if (at <= 0 || at >= buf.length || !isLongString(buf, at) || at % 4 === 0) return
    report.total++
    report.byTable[table] = (report.byTable[table] ?? 0) + 1
    if (report.examples.length < 5) {
      try {
        report.examples.push(decode(buf, at))
      } catch {
        // an example is optional
      }
    }
  }
  const rows = (t: TableType): number[] => db.rowLocations(t)
  for (const r of rows(TableType.ARTISTS)) {
    const far = buf.readUInt16LE(r) === 0x64
    check('artists', r + (far ? buf.readUInt16LE(r + 0x0a) : buf[r + 9]!))
  }
  for (const r of rows(TableType.ALBUMS)) {
    const far = buf.readUInt16LE(r) === 0x84
    check('albums', r + (far ? buf.readUInt16LE(r + 0x16) : buf[r + 21]!))
  }
  for (const r of rows(TableType.GENRES)) check('genres', r + 4)
  for (const r of rows(TableType.LABELS)) check('labels', r + 4)
  for (const r of rows(TableType.PLAYLIST_TREE)) check('playlists', r + 20)
  for (const r of rows(TableType.TRACKS)) {
    for (let i = 0; i < 21; i++) check('tracks', r + buf.readUInt16LE(r + 0x5e + i * 2))
  }
  return report
}
