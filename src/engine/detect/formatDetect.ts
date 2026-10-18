import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

export type ExportFormat = 'export.pdb' | 'exportLibrary.db'

export interface DetectedExport {
  format: ExportFormat
  /** Absolute path to the export file itself. */
  path: string
}

export interface VolumeExports {
  volumePath: string
  volumeName: string
  /** The PIONEER/rekordbox directory actually found (`PIONEER` or `.PIONEER`) - needed to place the on-USB backup folder alongside it. */
  rekordboxDir: string
  exports: DetectedExport[]
}

/**
 * Rekordbox has shipped the export folder both as `PIONEER` and as the
 * hidden `.PIONEER` (observed on real corrupted sticks) - check both.
 */
const PIONEER_DIR_NAMES = ['PIONEER', '.PIONEER'] as const

function rekordboxDirFor(volumePath: string): string | null {
  for (const name of PIONEER_DIR_NAMES) {
    const candidate = join(volumePath, name, 'rekordbox')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Inspect a single mounted volume for Rekordbox device exports. */
export function detectExportsOnVolume(volumePath: string, volumeName: string): VolumeExports | null {
  const rekordboxDir = rekordboxDirFor(volumePath)
  if (!rekordboxDir) return null

  const exports: DetectedExport[] = []

  const pdbPath = join(rekordboxDir, 'export.pdb')
  if (existsSync(pdbPath)) {
    exports.push({ format: 'export.pdb', path: pdbPath })
  }

  const onelibraryPath = join(rekordboxDir, 'exportLibrary.db')
  if (existsSync(onelibraryPath)) {
    exports.push({ format: 'exportLibrary.db', path: onelibraryPath })
  }

  if (exports.length === 0) return null

  return { volumePath, volumeName, rekordboxDir, exports }
}

/** Every mounted volume under /Volumes that holds a Rekordbox device export. */
export function scanMountedVolumesForExports(volumesRoot = '/Volumes'): VolumeExports[] {
  const found: VolumeExports[] = []
  let names: string[] = []
  try {
    names = readdirSync(volumesRoot).filter((n) => !n.startsWith('.'))
  } catch {
    return found
  }
  for (const name of names) {
    try {
      const v = detectExportsOnVolume(join(volumesRoot, name), name)
      if (v) found.push(v)
    } catch {
      // unreadable volume (permissions, ejecting): skip it
    }
  }
  return found
}
