/**
 * Corruption health check for a detected export - plan §4 step 2. Cheap
 * enough to run automatically the moment a drive is detected. Also
 * surfaces stale file paths (see relinkStalePaths.ts) as a separate
 * signal from structural corruption - a structurally healthy pdb can
 * still have tracks whose stored path doesn't resolve on disk.
 */
import { Worker } from 'worker_threads'
import { join } from 'path'
import { extractContentRecords } from '../sqlcipher/sqlCipherRecovery'
import type { DetectedExport } from '../detect/formatDetect'

export interface FormatHealth {
  format: DetectedExport['format']
  path: string
  healthy: boolean
  /** Human-readable per-table (pdb) or overall (db) problem descriptions. */
  issues: string[]
  trackCount: number | null
  /** Only meaningful for export.pdb, and only counted when structurally healthy. */
  stalePathCount: number | null
  /** export.pdb only: long/UTF-16 strings not on a 4-byte boundary (freezes XDJ-700 / older players). */
  misalignedStrings?: number | null
  misalignedExamples?: string[]
}

/**
 * Runs the actual parsing in a worker thread (checkPdbHealth.ts) rather
 * than inline on the main process - see that file's note. A stuck main
 * process would also stall the Rekordbox-running poll the safety check
 * depends on, so this can't be allowed to block there.
 */
export function checkPdbHealth(path: string, volumePath?: string): Promise<FormatHealth> {
  return new Promise((resolvePromise) => {
    const workerPath = join(__dirname, 'workers/checkPdbHealth.js')
    const worker = new Worker(workerPath, { workerData: { path, volumePath } })
    worker.once('message', (result: FormatHealth) => {
      worker.terminate()
      resolvePromise(result)
    })
    worker.once('error', (err) => {
      worker.terminate()
      resolvePromise({
        format: 'export.pdb',
        path,
        healthy: false,
        issues: [err instanceof Error ? err.message : String(err)],
        trackCount: null,
        stalePathCount: null
      })
    })
  })
}

export async function checkOneLibraryHealth(path: string): Promise<FormatHealth> {
  try {
    const rows = await extractContentRecords(path)
    return { format: 'exportLibrary.db', path, healthy: true, issues: [], trackCount: rows.length, stalePathCount: null }
  } catch (err) {
    return {
      format: 'exportLibrary.db',
      path,
      healthy: false,
      issues: [err instanceof Error ? err.message : String(err)],
      trackCount: null,
      stalePathCount: null
    }
  }
}

export async function checkExportHealth(detected: DetectedExport, volumePath?: string): Promise<FormatHealth> {
  return detected.format === 'export.pdb' ? checkPdbHealth(detected.path, volumePath) : checkOneLibraryHealth(detected.path)
}
