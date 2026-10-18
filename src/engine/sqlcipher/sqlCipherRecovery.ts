/**
 * `exportLibrary.db` (OneLibrary, SQLCipher-encrypted SQLite) access - plan
 * §1, §3.
 *
 * Same underlying technology as Rekordbox's desktop master.db, so repair
 * itself (Phase 1, not yet implemented) reuses well-trodden SQLite
 * recovery patterns: integrity-check, page-level salvage of whatever's
 * readable, rebuild a fresh valid database from that. Uses
 * better-sqlite3-multiple-ciphers (see package.json).
 *
 * All access to this file MUST go through the isolated worker
 * (src/main/workers/extractOneLibrary.ts), never opened directly in this
 * process - see the plan's note on the confirmed native crash in this
 * dependency when Statement objects are garbage-collected alongside the
 * pdb writer's heavy Buffer work.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'

const execFileAsync = promisify(execFile)

/**
 * Static, universal SQLCipher key for Device Library Plus / OneLibrary
 * databases - hardcoded by Rekordbox itself, not machine- or
 * license-specific. Source: community reverse-engineering (obfuscated in
 * the app via base85 + XOR + zlib; this is the already-decoded value).
 */
export const ONELIBRARY_SQLCIPHER_KEY = 'r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls'

/**
 * A `content` (track) row from exportLibrary.db, with lookup-table names
 * already joined in. Defined here (the engine layer) rather than in the
 * worker script, so engine/ stays dependency-free of main/ - the worker
 * imports this type, not the other way around.
 */
export interface ContentRecord {
  title: string
  path: string
  fileName: string
  artistName: string | null
  albumName: string | null
  genreName: string | null
  keyName: string | null
  labelName: string | null
  bpmx100: number
  length: number
  fileSize: number
  bitrate: number
  samplingRate: number
  bitDepth: number
  releaseYear: number
  trackNo: number
  discNo: number
  rating: number
  djPlayCount: number
}

export interface AlbumRecord {
  name: string
  artistName: string | null
}

export interface PlaylistRecord {
  id: number
  name: string
  parentId: number
  isFolder: boolean
  sequenceNo: number
}

export interface PlaylistContentRecord {
  playlistId: number
  /** The track's file path, not its exportLibrary content_id - ids aren't
   * shared with export.pdb (confirmed empirically: they diverge from
   * track ~68 onward in the real fixture), so path is the only reliable
   * cross-format join key, same as track reconciliation. */
  trackPath: string
  sequenceNo: number
}

/** Everything needed to reconcile every recoverable table, not just tracks - plan's "Tier 0 cover all tables". */
export interface FullLibraryExtraction {
  tracks: ContentRecord[]
  genres: string[]
  artists: string[]
  albums: AlbumRecord[]
  labels: string[]
  keys: string[]
  playlists: PlaylistRecord[]
  playlistContent: PlaylistContentRecord[]
}

interface WorkerSuccess {
  ok: true
  data: FullLibraryExtraction
}
interface WorkerFailure {
  ok: false
  error: string
}

async function runExtractionWorker(dbPath: string): Promise<FullLibraryExtraction> {
  // NOT source-tree-relative ('../../main/workers/...') - electron-vite
  // bundles every file reachable from the main entry into a single
  // out/main/index.js, so __dirname at runtime is always out/main/,
  // regardless of which src/ file this code originally lived in. The
  // worker is a separate build entry at out/main/workers/, so this is the
  // one correct relative path from wherever the bundle actually runs.
  const workerPath = join(__dirname, 'workers/extractOneLibrary.js')
  try {
    const { stdout } = await execFileAsync(process.execPath, [workerPath, dbPath, ONELIBRARY_SQLCIPHER_KEY], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      maxBuffer: 64 * 1024 * 1024 // a few thousand tracks' worth of JSON, generously bounded
    })
    const parsed = JSON.parse(stdout) as WorkerSuccess
    return parsed.data
  } catch (err) {
    // execFile rejects with stderr attached when the child exits non-zero.
    const stderr = (err as { stderr?: string }).stderr
    if (stderr) {
      try {
        const parsed = JSON.parse(stderr) as WorkerFailure
        throw new Error(`exportLibrary.db extraction failed: ${parsed.error}`)
      } catch {
        // stderr wasn't our JSON error shape - fall through to rethrow raw
      }
    }
    throw err
  }
}

/**
 * Extracts everything needed for full-table Tier 0 reconciliation from a
 * healthy exportLibrary.db, via the isolated worker process.
 */
export async function extractFullLibrary(dbPath: string): Promise<FullLibraryExtraction> {
  return runExtractionWorker(dbPath)
}

/** Lightweight convenience wrapper for callers (e.g. the health check) that only need track rows. */
export async function extractContentRecords(dbPath: string): Promise<ContentRecord[]> {
  const full = await runExtractionWorker(dbPath)
  return full.tracks
}

export interface SqlCipherRepairSummary {
  tracksRecovered: number
  tracksExpected: number
  playlistsRecovered: number
  playlistsExpected: number
  notes: string[]
}

export interface SqlCipherRepairResult {
  buffer: Buffer
  summary: SqlCipherRepairSummary
}

export function repairExportLibraryDb(_originalPath: string): SqlCipherRepairResult {
  throw new Error('repairExportLibraryDb: not implemented yet (Phase 1, plan §5)')
}
