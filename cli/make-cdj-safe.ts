/**
 * Command-line "Make CDJ-safe" for any OS with Node (macOS, Linux, Windows).
 *
 * Rebuilds a Rekordbox device export.pdb so every long string starts on a 4-byte boundary,
 * which is what freezes the XDJ-700 v1.15 (and CDJ-2000NXS2) on insert. Same engine as the
 * app's "Make CDJ-safe" button. Never touches the input file: the result goes to a new file
 * and is only written when it re-reads cleanly with every track and playlist still there.
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
const before = new Database(src)
const bad = findMisalignedStrings(src, before)
console.log(`input:  ${inPath}`)
console.log(`        ${before.tracks.length} tracks, ${before.playlistTree.length} playlists/folders`)
console.log(`        ${bad.total} misaligned strings ${JSON.stringify(bad.byTable)}`)
if (bad.examples.length) console.log(`        e.g. ${bad.examples.map((e) => JSON.stringify(e)).join(', ')}`)

const out = rebuildPdbFromScan(scanPdbPages(src)).buffer
const after = new Database(out)
const stillBad = findMisalignedStrings(out, after)

const problems: string[] = []
if (after.tableErrors.size) problems.push(`rebuilt file has table errors: ${[...after.tableErrors.values()].join('; ')}`)
if (after.tracks.length < before.tracks.length)
  problems.push(`tracks dropped: ${before.tracks.length} -> ${after.tracks.length}`)
if (after.playlistTree.length < before.playlistTree.length)
  problems.push(`playlists dropped: ${before.playlistTree.length} -> ${after.playlistTree.length}`)
if (stillBad.total) problems.push(`${stillBad.total} strings still misaligned`)
if (problems.length) {
  console.error('\nNOT written, the rebuild did not verify:\n  ' + problems.join('\n  '))
  process.exit(1)
}

writeFileSync(outPath, out)
console.log(`output: ${outPath}`)
console.log(`        ${after.tracks.length} tracks, ${after.playlistTree.length} playlists/folders, 0 misaligned strings`)
console.log(
  '\nTo use it: back up the stick\'s PIONEER folder first, then replace PIONEER/rekordbox/export.pdb' +
    '\n(on a Mac-formatted stick: .PIONEER/rekordbox/export.pdb) with this file, named export.pdb.'
)
