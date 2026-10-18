/**
 * Regenerates a fresh `exportLibrary.db` from a healthy `export.pdb` -
 * plan Phase 2. The reverse direction of sqlCipherRecovery.ts: that file
 * reads a healthy db to help fix a corrupted pdb; this builds a brand new
 * db from a healthy (or just-salvaged) pdb, for when the db itself is
 * missing or corrupted.
 *
 * Deliberately narrower than the full real schema (see
 * oneLibrarySchema.ts's module doc): only the 8 tables a pdb can actually
 * supply data for are populated. Everything else (hot cues, history, My
 * Tags, images, categories, colors, sort order, recommendations) is left
 * as an empty, correctly-shaped table - not fabricated. This has NOT been
 * validated against real Rekordbox software reading the result back
 * (only against this project's own reader) - see the caller's UI copy,
 * which must stay explicit about that.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Database } from '../pdb/pdbReader'
import { ONELIBRARY_SQLCIPHER_KEY } from './sqlCipherRecovery'

const execFileAsync = promisify(execFile)

interface BuildTrackInput {
  id: number
  title: string
  filePath: string
  filename: string
  fileSize: number
  bitrate: number
  sampleRate: number
  sampleDepth: number
  duration: number
  tempo: number
  trackNumber: number
  discNumber: number
  playCount: number
  rating: number
  year: number
  dateAdded: string
  genreId: number
  artistId: number
  albumId: number
  keyId: number
  labelId: number
}

interface BuildNamedInput {
  id: number
  name: string
}

interface BuildAlbumInput extends BuildNamedInput {
  artistId: number
}

interface BuildPlaylistInput {
  id: number
  name: string
  parentId: number
  isFolder: boolean
  sortOrder: number
}

interface BuildPlaylistEntryInput {
  playlistId: number
  trackId: number
  entryIndex: number
}

/** Serialized to a temp JSON file and read by the isolated worker (buildOneLibrary.ts, main process). */
export interface OneLibraryBuildInput {
  deviceName: string
  tracks: BuildTrackInput[]
  genres: BuildNamedInput[]
  artists: BuildNamedInput[]
  albums: BuildAlbumInput[]
  labels: BuildNamedInput[]
  keys: BuildNamedInput[]
  playlists: BuildPlaylistInput[]
  playlistEntries: BuildPlaylistEntryInput[]
}

export interface OneLibraryBuildSummary {
  tracksWritten: number
  genresWritten: number
  artistsWritten: number
  albumsWritten: number
  labelsWritten: number
  keysWritten: number
  playlistsWritten: number
  playlistEntriesWritten: number
}

/** Builds the worker input directly from a parsed pdb Database - ids are pdb-local and carried through unchanged, since this is a fresh db with no prior id space to conflict with. */
function buildInputFromPdb(pdb: Database, deviceName: string): OneLibraryBuildInput {
  return {
    deviceName,
    tracks: pdb.tracks.map((t) => ({
      id: t.id,
      title: t.title,
      filePath: t.filePath,
      filename: t.filename,
      fileSize: t.fileSize,
      bitrate: t.bitrate,
      sampleRate: t.sampleRate,
      sampleDepth: t.sampleDepth,
      duration: t.duration,
      tempo: t.tempo,
      trackNumber: t.trackNumber,
      discNumber: t.discNumber,
      playCount: t.playCount,
      rating: t.rating,
      year: t.year,
      dateAdded: t.dateAdded,
      genreId: t.genreId,
      artistId: t.artistId,
      albumId: t.albumId,
      keyId: t.keyId,
      labelId: t.labelId
    })),
    genres: pdb.genres.map((g) => ({ id: g.id, name: g.name })),
    artists: pdb.artists.map((a) => ({ id: a.id, name: a.name })),
    albums: pdb.albums.map((a) => ({ id: a.id, name: a.name, artistId: a.artistId })),
    labels: pdb.labels.map((l) => ({ id: l.id, name: l.name })),
    keys: pdb.keys.map((k) => ({ id: k.id, name: k.name })),
    playlists: pdb.playlistTree.map((p) => ({ id: p.id, name: p.name, parentId: p.parentId, isFolder: p.isFolder, sortOrder: p.sortOrder })),
    playlistEntries: pdb.playlistEntries.map((e) => ({ playlistId: e.playlistId, trackId: e.trackId, entryIndex: e.entryIndex }))
  }
}

export async function buildOneLibraryFromPdb(pdb: Database, outputPath: string, deviceName: string): Promise<OneLibraryBuildSummary> {
  const input = buildInputFromPdb(pdb, deviceName)
  const inputPath = `${outputPath}.build-input.json`
  writeFileSync(inputPath, JSON.stringify(input))

  const workerPath = join(__dirname, 'workers/buildOneLibrary.js')
  try {
    const { stdout } = await execFileAsync(process.execPath, [workerPath, inputPath, outputPath, ONELIBRARY_SQLCIPHER_KEY], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      maxBuffer: 4 * 1024 * 1024
    })
    const parsed = JSON.parse(stdout) as { ok: true; summary: OneLibraryBuildSummary }
    return parsed.summary
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr
    if (stderr) {
      try {
        const parsed = JSON.parse(stderr) as { ok: false; error: string }
        throw new Error(`exportLibrary.db build failed: ${parsed.error}`)
      } catch {
        // stderr wasn't our JSON error shape - fall through to rethrow raw
      }
    }
    throw err
  } finally {
    try {
      unlinkSync(inputPath)
    } catch {
      // best-effort cleanup only
    }
  }
}
