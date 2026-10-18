import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Can the player mount this stick at all? Independent of the database: a perfect export.pdb on
 * a wrongly formatted stick still shows "FORMAT USB" on the player.
 *
 * Rules found by running the real XDJ-700 v1.15 firmware in emulation (2026-10-17), with only
 * PIONEER/rekordbox/export.pdb on a 32 GB stick:
 * - FAT32 on MBR (FAT partition type) or with no partition table: mounts.
 * - FAT32 on GPT (what Windows 11 often creates), even as the only partition: "FORMAT USB".
 * - MBR partition typed Linux (0x83, fdisk's default): "FORMAT USB" (macOS won't mount it either).
 * - HFS+ on GPT (macOS default): mounts, but the library is only found in `.PIONEER`; with
 *   `PIONEER` the player shows a plain folder view.
 * exFAT/NTFS/APFS are not readable by pre-CDJ-3000 players (Pioneer's supported list is
 * FAT16/FAT32/HFS+).
 */
export interface StickFormatReport {
  /** null = could not be determined (diskutil failed); treat as unknown, not as a problem. */
  ok: boolean | null
  filesystem: string
  partitionScheme: 'MBR' | 'GPT' | 'none' | 'unknown'
  problem?: string
}

function diskutilInfo(target: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    execFile('diskutil', ['info', '-plist', target], { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err)
      // Only flat top-level <key>/<string> pairs are needed.
      const out: Record<string, string> = {}
      for (const m of stdout.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) out[m[1]!] = m[2]!
      resolve(out)
    })
  })
}

export function judgeStickFormat(
  vol: Record<string, string>,
  whole: Record<string, string>,
  hasDotPioneerLibrary: boolean
): StickFormatReport {
  const fsType = vol.FilesystemType ?? ''
  const filesystem = vol.FilesystemName || vol.FilesystemUserVisibleName || fsType || 'unknown'
  const scheme = whole.Content ?? ''
  const partitionScheme =
    vol.DeviceIdentifier && vol.DeviceIdentifier === vol.ParentWholeDisk
      ? 'none'
      : scheme === 'GUID_partition_scheme'
        ? 'GPT'
        : scheme === 'FDisk_partition_scheme'
          ? 'MBR'
          : 'unknown'
  const report = { filesystem, partitionScheme } as const

  if (fsType === 'msdos') {
    if (partitionScheme === 'GPT') {
      return {
        ...report,
        ok: false,
        problem:
          'This stick uses a GPT partition table. An XDJ-700 shows "FORMAT USB" and won\'t read it. Reformat it as FAT32 with an MBR (Master Boot Record) partition table.'
      }
    }
    if (partitionScheme === 'MBR' && vol.Content && !/FAT/i.test(vol.Content)) {
      return {
        ...report,
        ok: false,
        problem: `The partition is labelled "${vol.Content}", not FAT. An XDJ-700 shows "FORMAT USB". Reformat it as FAT32 (MBR).`
      }
    }
    return { ...report, ok: true }
  }
  if (fsType === 'hfs') {
    if (!hasDotPioneerLibrary) {
      return {
        ...report,
        ok: false,
        problem:
          'On a Mac-formatted (HFS+) stick the player looks for the hidden ".PIONEER" folder. With "PIONEER" it shows only folders, not your library.'
      }
    }
    return { ...report, ok: true }
  }
  if (fsType) {
    return {
      ...report,
      ok: false,
      problem: `${filesystem} can't be read by an XDJ-700 or other pre-CDJ-3000 players. Use FAT32 (MBR).`
    }
  }
  return { ...report, ok: null }
}

export async function checkStickFormat(volumePath: string): Promise<StickFormatReport> {
  try {
    const vol = await diskutilInfo(volumePath)
    const whole =
      vol.ParentWholeDisk && vol.ParentWholeDisk !== vol.DeviceIdentifier
        ? await diskutilInfo(vol.ParentWholeDisk)
        : vol
    return judgeStickFormat(vol, whole, existsSync(join(volumePath, '.PIONEER', 'rekordbox', 'export.pdb')))
  } catch {
    return { ok: null, filesystem: 'unknown', partitionScheme: 'unknown' }
  }
}
