/**
 * Command-line repair for any OS with Node (macOS, Linux, Windows).
 *
 * Rebuilds a Rekordbox device export.pdb from every row that is still readable in it, page by
 * page, so a corrupted or truncated file gets a clean, complete structure again. Every long
 * string comes out on a 4-byte boundary too, which is what freezes the XDJ-700 v1.15 (and
 * CDJ-2000NXS2) on insert. Same engine as the app. Never touches the input file: the result
 * goes to a new file and is only written when it re-reads cleanly.
 *
 *   npx tsx cli/make-cdj-safe.ts <path/to/export.pdb> [output.pdb]
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { Database } from '../src/engine/pdb/pdbReader'
import { scanPdbPages } from '../src/engine/pdb/pdbPageScanner'
import { rebuildPdbFromScan } from '../src/engine/pdb/pdbRebuilder'
import { findMisalignedStrings } from '../src/engine/pdb/cdjSafety'

const [input, outArg] = process.argv.slice(2)
if (!input) {
  console.error('usage: npx tsx cli/make-cdj-safe.ts <path/to/export.pdb> [output.pdb]')
  process.exit(2)
}
const inPath = resolve(input)
const outPath = resolve(outArg ?? `${inPath}.cdj-safe`)
if (outPath === inPath) {
  console.error('Refusing to overwrite the input file. Give a different output path.')
  process.exit(2)
}
if (existsSync(outPath)) {
  console.error(`${outPath} already exists. Delete it or give another output path.`)
  process.exit(2)
}

const src = readFileSync(inPath)
console.log(`input:  ${inPath}`)
// A corrupted file may not read normally at all; the rebuild below doesn't need it to.
let before: Database | null = null
try {
  before = new Database(src)
  const bad = findMisalignedStrings(src, before)
  console.log(`        ${before.tracks.length} tracks, ${before.playlistTree.length} playlists/folders readable`)
  if (before.tableErrors.size) console.log(`        damaged: ${[...before.tableErrors.values()].join('; ')}`)
  console.log(`        ${bad.total} misaligned strings ${JSON.stringify(bad.byTable)}`)
  if (bad.examples.length) console.log(`        e.g. ${bad.examples.map((e) => JSON.stringify(e)).join(', ')}`)
} catch (err) {
  before = null
  console.log(`        can't be read normally (${(err as Error).message}); recovering what survives`)
}

const { buffer: out, summary } = rebuildPdbFromScan(scanPdbPages(src))
const after = new Database(out)
const stillBad = findMisalignedStrings(out, after)

const problems: string[] = []
if (after.tableErrors.size) problems.push(`rebuilt file has table errors: ${[...after.tableErrors.values()].join('; ')}`)
if (before && after.tracks.length < before.tracks.length)
  problems.push(`tracks dropped: ${before.tracks.length} -> ${after.tracks.length}`)
if (before && after.playlistTree.length < before.playlistTree.length)
  problems.push(`playlists dropped: ${before.playlistTree.length} -> ${after.playlistTree.length}`)
if (!after.tracks.length) problems.push('no tracks could be recovered')
if (stillBad.total) problems.push(`${stillBad.total} strings still misaligned`)
if (problems.length) {
  console.error('\nNOT written, the rebuild did not verify:\n  ' + problems.join('\n  '))
  process.exit(1)
}

writeFileSync(outPath, out)
console.log(`output: ${outPath}`)
console.log(`        ${after.tracks.length} tracks, ${after.playlistTree.length} playlists/folders, ${after.playlistEntries.length} playlist entries, 0 misaligned strings`)
for (const note of summary.notes) console.log(`        note: ${note}`)
console.log(
  '\nTo use it: back up the stick\'s PIONEER folder first, then replace PIONEER/rekordbox/export.pdb' +
    '\n(on a Mac-formatted stick: .PIONEER/rekordbox/export.pdb) with this file, named export.pdb.'
)
