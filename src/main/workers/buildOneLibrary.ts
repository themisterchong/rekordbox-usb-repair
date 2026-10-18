/**
 * Runs as a short-lived, isolated child process (never the main process) -
 * same reasoning as extractOneLibrary.ts: keep any Buffer-heavy pdb work
 * out of the same process/GC cycles as SQLite statement finalization.
 *
 * Invocation: forked with the input JSON path (a serialized
 * OneLibraryBuildInput, written by the caller) as argv[2], the output db
 * path as argv[3], and the SQLCipher key as argv[4]. Result goes to
 * stdout as one JSON line; a fatal error goes to stderr with a non-zero
 * exit code.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { readFileSync, unlinkSync } from 'fs'
import { ONELIBRARY_TABLE_SQL, ONELIBRARY_INDEX_SQL } from '../../engine/sqlcipher/oneLibrarySchema'
import type { OneLibraryBuildInput, OneLibraryBuildSummary } from '../../engine/sqlcipher/buildOneLibrary'

function main(): void {
  const inputPath = process.argv[2]
  const outputPath = process.argv[3]
  const key = process.argv[4]
  if (!inputPath || !outputPath || !key) {
    process.stderr.write('usage: buildOneLibrary.js <inputJsonPath> <outputDbPath> <sqlCipherKey>\n')
    process.exit(2)
  }

  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as OneLibraryBuildInput
  // A previous failed attempt could have left a partial file - SQLCipher
  // will not open an existing unencrypted/differently-keyed file cleanly,
  // so start from nothing every time, same spirit as the pdb side always
  // writing to a fresh temp path rather than reusing one.
  try {
    unlinkSync(outputPath)
  } catch {
    // didn't exist - fine
  }

  let db: InstanceType<typeof DatabaseCtor> | null = null
  try {
    db = new DatabaseCtor(outputPath)
    // Must be set before the first write - this is what makes the file
    // genuinely SQLCipher-encrypted from its very first byte, not a plain
    // SQLite file with these pragmas ignored.
    db.pragma("cipher = 'sqlcipher'")
    db.pragma('legacy = 4')
    db.pragma(`key = '${key.replace(/'/g, "''")}'`)

    for (const sql of ONELIBRARY_TABLE_SQL) db.exec(sql)
    for (const sql of ONELIBRARY_INDEX_SQL) db.exec(sql)

    const insertGenre = db.prepare('INSERT INTO genre (genre_id, name) VALUES (?, ?)')
    const insertArtist = db.prepare('INSERT INTO artist (artist_id, name, nameForSearch) VALUES (?, ?, ?)')
    const insertAlbum = db.prepare('INSERT INTO album (album_id, name, artist_id, nameForSearch) VALUES (?, ?, ?, ?)')
    const insertLabel = db.prepare('INSERT INTO label (label_id, name) VALUES (?, ?)')
    const insertKey = db.prepare('INSERT INTO key (key_id, name) VALUES (?, ?)')
    const insertContent = db.prepare(
      `INSERT INTO content (
        content_id, title, titleForSearch, bpmx100, length, trackNo, discNo,
        artist_id_artist, album_id, genre_id, label_id, key_id, rating,
        releaseYear, dateAdded, path, fileName, fileSize, bitrate, bitDepth,
        samplingRate, djPlayCount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertPlaylist = db.prepare(
      'INSERT INTO playlist (playlist_id, sequenceNo, name, attribute, playlist_id_parent) VALUES (?, ?, ?, ?, ?)'
    )
    const insertPlaylistContent = db.prepare('INSERT INTO playlist_content (playlist_id, content_id, sequenceNo) VALUES (?, ?, ?)')
    const insertProperty = db.prepare(
      'INSERT INTO property (deviceName, dbVersion, numberOfContents, createdDate, backGroundColorType) VALUES (?, ?, ?, ?, ?)'
    )

    const insertAll = db.transaction(() => {
      for (const g of input.genres) insertGenre.run(g.id, g.name)
      for (const a of input.artists) insertArtist.run(a.id, a.name, a.name)
      for (const a of input.albums) insertAlbum.run(a.id, a.name, a.artistId, a.name)
      for (const l of input.labels) insertLabel.run(l.id, l.name)
      for (const k of input.keys) insertKey.run(k.id, k.name)
      for (const t of input.tracks) {
        insertContent.run(
          t.id,
          t.title,
          t.title,
          t.tempo,
          t.duration,
          t.trackNumber,
          t.discNumber,
          t.artistId,
          t.albumId,
          t.genreId,
          t.labelId,
          t.keyId,
          t.rating,
          t.year,
          t.dateAdded,
          t.filePath,
          t.filename,
          t.fileSize,
          t.bitrate,
          t.sampleDepth,
          t.sampleRate,
          t.playCount
        )
      }
      for (const p of input.playlists) insertPlaylist.run(p.id, p.sortOrder, p.name, p.isFolder ? 1 : 0, p.parentId)
      for (const e of input.playlistEntries) insertPlaylistContent.run(e.playlistId, e.trackId, e.entryIndex)
      insertProperty.run(input.deviceName, '1000', input.tracks.length, new Date().toISOString().slice(0, 10), 0)
    })
    insertAll()

    db.close()
    const summary: OneLibraryBuildSummary = {
      tracksWritten: input.tracks.length,
      genresWritten: input.genres.length,
      artistsWritten: input.artists.length,
      albumsWritten: input.albums.length,
      labelsWritten: input.labels.length,
      keysWritten: input.keys.length,
      playlistsWritten: input.playlists.length,
      playlistEntriesWritten: input.playlistEntries.length
    }
    process.stdout.write(JSON.stringify({ ok: true, summary }), () => process.exit(0))
  } catch (err) {
    try {
      db?.close()
    } catch {
      // already broken
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(JSON.stringify({ ok: false, error: message }), () => process.exit(1))
  }
}

main()
