/**
 * Runs as a short-lived, isolated child process (never the main process) -
 * see plan's note on the confirmed native crash in
 * better-sqlite3-multiple-ciphers when its Statement objects get
 * garbage-collected alongside heavy Buffer work. This process does exactly
 * one job (extract everything needed for Tier 0 reconciliation from
 * exportLibrary.db) and exits, so that crash class never has a chance to
 * happen: no pdb-writer Buffer work ever runs in the same process/GC
 * cycles as SQLite statement finalization.
 *
 * Invocation: forked with the db path as argv[2] and the SQLCipher key as
 * argv[3]. Result goes to stdout as one JSON line; a fatal error goes to
 * stderr with a non-zero exit code, never a thrown IPC message the parent
 * has to distinguish from a crash.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type {
  ContentRecord,
  AlbumRecord,
  PlaylistRecord,
  PlaylistContentRecord,
  FullLibraryExtraction
} from '../../engine/sqlcipher/sqlCipherRecovery'

export type { ContentRecord, AlbumRecord, PlaylistRecord, PlaylistContentRecord, FullLibraryExtraction }

function main(): void {
  const dbPath = process.argv[2]
  const key = process.argv[3]
  if (!dbPath || !key) {
    process.stderr.write('usage: extractOneLibrary.js <dbPath> <sqlCipherKey>\n')
    process.exit(2)
  }

  let db: InstanceType<typeof DatabaseCtor> | null = null
  try {
    db = new DatabaseCtor(dbPath, { readonly: true })
    db.pragma("cipher = 'sqlcipher'")
    db.pragma('legacy = 4')
    db.pragma(`key = '${key.replace(/'/g, "''")}'`)

    const tracks = db
      .prepare(
        `SELECT c.title, c.path, c.fileName, ar.name as artistName, al.name as albumName, g.name as genreName,
                k.name as keyName, l.name as labelName, c.bpmx100, c.length, c.fileSize, c.bitrate,
                c.samplingRate, c.bitDepth, c.releaseYear, c.trackNo, c.discNo, c.rating, c.djPlayCount
         FROM content c
         LEFT JOIN artist ar ON ar.artist_id = c.artist_id_artist
         LEFT JOIN album al ON al.album_id = c.album_id
         LEFT JOIN genre g ON g.genre_id = c.genre_id
         LEFT JOIN key k ON k.key_id = c.key_id
         LEFT JOIN label l ON l.label_id = c.label_id
         ORDER BY c.content_id`
      )
      .all() as ContentRecord[]

    const genres = (db.prepare('SELECT name FROM genre ORDER BY genre_id').all() as Array<{ name: string }>).map(
      (r) => r.name
    )
    const artists = (db.prepare('SELECT name FROM artist ORDER BY artist_id').all() as Array<{ name: string }>).map(
      (r) => r.name
    )
    const labels = (db.prepare('SELECT name FROM label ORDER BY label_id').all() as Array<{ name: string }>).map(
      (r) => r.name
    )
    const keys = (db.prepare('SELECT name FROM key ORDER BY key_id').all() as Array<{ name: string }>).map(
      (r) => r.name
    )
    const albums = db
      .prepare(
        `SELECT al.name as name, ar.name as artistName
         FROM album al LEFT JOIN artist ar ON ar.artist_id = al.artist_id
         ORDER BY al.album_id`
      )
      .all() as AlbumRecord[]

    const playlists = (
      db
        .prepare(
          `SELECT playlist_id as id, name, playlist_id_parent as parentId, attribute, sequenceNo
           FROM playlist ORDER BY playlist_id`
        )
        .all() as Array<{ id: number; name: string; parentId: number; attribute: number; sequenceNo: number }>
    ).map((r) => ({ id: r.id, name: r.name, parentId: r.parentId, isFolder: r.attribute !== 0, sequenceNo: r.sequenceNo }))

    const playlistContent = db
      .prepare(
        `SELECT pc.playlist_id as playlistId, c.path as trackPath, pc.sequenceNo as sequenceNo
         FROM playlist_content pc JOIN content c ON c.content_id = pc.content_id
         ORDER BY pc.playlist_id, pc.sequenceNo`
      )
      .all() as PlaylistContentRecord[]

    const data: FullLibraryExtraction = { tracks, genres, artists, albums, labels, keys, playlists, playlistContent }

    db.close()
    // write()'s callback fires once the data is actually flushed - exiting
    // before that (a bare process.exit() right after write(), with no
    // wait) can silently truncate large output. Caught via the real
    // fixture: 579KB of JSON, corrupted exactly this way when piped
    // through execFile rather than a terminal.
    process.stdout.write(JSON.stringify({ ok: true, data }), () => process.exit(0))
  } catch (err) {
    try {
      db?.close()
    } catch {
      // already broken; nothing more to do
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(JSON.stringify({ ok: false, error: message }), () => process.exit(1))
  }
}

main()
