/**
 * Filesystem-level (exFAT/FAT32) repair - plan §1 point 3, Phase 4.
 * Not Rekordbox-specific - shells out to macOS's own tools rather than
 * reinventing filesystem repair. Runs as an automatic first pass before
 * any pdb/db-specific checks.
 */
export interface FilesystemCheckResult {
  healthy: boolean
  repaired: boolean
  output: string
}

/**
 * Checks (and if needed, repairs) the filesystem of the volume at
 * `volumePath` using `diskutil verifyVolume` / `repairVolume`.
 */
export async function checkAndRepairFilesystem(_volumePath: string): Promise<FilesystemCheckResult> {
  throw new Error('checkAndRepairFilesystem: not implemented yet (Phase 4, plan §5)')
}
