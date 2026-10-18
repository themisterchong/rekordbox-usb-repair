/**
 * Runs `export.pdb` structural parsing off the main thread - see
 * checkHealth.ts. Parsing a large or adversarially-corrupted pdb (e.g. a
 * page chain the reader has to walk defensively) can take a while; doing
 * that synchronously on the main process would stall everything else
 * that also runs there, including the Rekordbox-running poll the safety
 * check depends on.
 */
import { parentPort, workerData } from 'worker_threads'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { Database } from '../../engine/pdb/pdbReader'
import { findMisalignedStrings } from '../../engine/pdb/cdjSafety'
import type { FormatHealth } from '../../engine/repair/checkHealth'

function run(): FormatHealth {
  const { path, volumePath } = workerData as { path: string; volumePath?: string }
  try {
    const buf = readFileSync(path)
    const db = new Database(buf)
    const issues = [...db.tableErrors.entries()].map(([type, err]) => `table ${type}: ${err}`)
    const healthy = issues.length === 0
    let stalePathCount: number | null = null
    if (healthy && volumePath) {
      stalePathCount = db.tracks.filter((t) => !existsSync(join(volumePath, t.filePath.replace(/^\//, '')))).length
    }
    let misalignedStrings: number | null = null
    let misalignedExamples: string[] = []
    if (healthy) {
      const report = findMisalignedStrings(buf, db)
      misalignedStrings = report.total
      misalignedExamples = report.examples
    }
    return { format: 'export.pdb', path, healthy, issues, trackCount: db.tracks.length, stalePathCount, misalignedStrings, misalignedExamples }
  } catch (err) {
    return {
      format: 'export.pdb',
      path,
      healthy: false,
      issues: [err instanceof Error ? err.message : String(err)],
      trackCount: null,
      stalePathCount: null
    }
  }
}

parentPort?.postMessage(run())
