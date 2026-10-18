import { ipcMain, app, dialog } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { scanMountedVolumesForExports } from '../engine/detect/formatDetect'
import { checkStickFormat } from '../engine/detect/stickFormat'
import { planReformat, reformatStick, restoreStickFromBackup } from '../engine/repair/reformatStick'
import type { ReformatJob, ReformatProgress, ReformatResult } from '../engine/repair/reformatStick'
import { isRekordboxInstalled, isRekordboxRunning, openRekordbox } from '../engine/detect/rekordboxDetect'
import { checkExportHealth } from '../engine/repair/checkHealth'
import { repairPdbViaTier0 } from '../engine/repair/tier0PdbRepair'
import { repairPdbViaStandaloneSalvage } from '../engine/repair/standaloneSalvage'
import { regenerateOneLibraryFromPdb } from '../engine/repair/regenerateOneLibrary'
import { relinkStalePathsInPdb } from '../engine/repair/relinkStalePaths'
import type { DetectedExport } from '../engine/detect/formatDetect'
import type { Tier0RepairRequest } from '../engine/repair/tier0PdbRepair'
import type { StandaloneSalvageRequest } from '../engine/repair/standaloneSalvage'
import type { RegenerateOneLibraryRequest } from '../engine/repair/regenerateOneLibrary'
import type { RelinkRequest } from '../engine/repair/relinkStalePaths'

ipcMain.handle('scan-for-exports', () => {
  return scanMountedVolumesForExports()
})

ipcMain.handle('check-export-health', async (_event, detected: DetectedExport, volumePath?: string) => {
  return checkExportHealth(detected, volumePath)
})

ipcMain.handle('check-stick-format', async (_event, volumePath: string) => {
  return checkStickFormat(volumePath)
})

ipcMain.handle('rekordbox-status', async () => {
  const [installed, running] = await Promise.all([isRekordboxInstalled(), isRekordboxRunning()])
  return { installed, running }
})

ipcMain.handle('open-rekordbox', async () => {
  await openRekordbox()
})

ipcMain.handle('repair-tier0', async (_event, params: Tier0RepairRequest) => {
  // Must be re-checked here, not just trusted from an earlier UI state -
  // Rekordbox could have been (re)launched at any point up to this click,
  // and it may have the same USB mounted (plan §4's sequencing detail).
  if (await isRekordboxRunning()) {
    throw new Error('Rekordbox is currently running - please quit it, then try again')
  }
  const usbBackupDir = join(params.rekordboxDir, 'rekordbox_repair_backup')
  const localBackupDir = join(app.getPath('userData'), 'repair-backups')
  return repairPdbViaTier0({
    corruptedPdbPath: params.corruptedPdbPath,
    healthyOneLibraryPath: params.healthyOneLibraryPath,
    usbBackupDir,
    localBackupDir,
    driveLabel: params.volumeName
  })
})

ipcMain.handle('repair-standalone-salvage', async (_event, params: StandaloneSalvageRequest) => {
  if (await isRekordboxRunning()) {
    throw new Error('Rekordbox is currently running - please quit it, then try again')
  }
  const usbBackupDir = join(params.rekordboxDir, 'rekordbox_repair_backup')
  const localBackupDir = join(app.getPath('userData'), 'repair-backups')
  return repairPdbViaStandaloneSalvage({
    corruptedPdbPath: params.corruptedPdbPath,
    usbBackupDir,
    localBackupDir,
    driveLabel: params.volumeName
  })
})

ipcMain.handle('regenerate-onelibrary', async (_event, params: RegenerateOneLibraryRequest) => {
  if (await isRekordboxRunning()) {
    throw new Error('Rekordbox is currently running - please quit it, then try again')
  }
  const usbBackupDir = join(params.rekordboxDir, 'rekordbox_repair_backup')
  const localBackupDir = join(app.getPath('userData'), 'repair-backups')
  return regenerateOneLibraryFromPdb({
    healthyPdbPath: params.healthyPdbPath,
    targetPath: join(params.rekordboxDir, 'exportLibrary.db'),
    usbBackupDir,
    localBackupDir,
    driveLabel: params.volumeName
  })
})

ipcMain.handle('relink-stale-paths', async (_event, params: RelinkRequest) => {
  if (await isRekordboxRunning()) {
    throw new Error('Rekordbox is currently running - please quit it, then try again')
  }
  const usbBackupDir = join(params.rekordboxDir, 'rekordbox_repair_backup')
  const localBackupDir = join(app.getPath('userData'), 'repair-backups')
  return relinkStalePathsInPdb({
    pdbPath: params.pdbPath,
    searchRoot: params.volumePath,
    usbBackupDir,
    localBackupDir,
    driveLabel: params.volumeName
  })
})

// Reformatting runs as a job in the main process: the stick disappears from /Volumes while it is
// erased (and may come back under another name), so the renderer card that started it can't own it.

const reformatJobs = new Map<string, ReformatJob>()
const defaultStickBackupRoot = (): string => join(app.getPath('documents'), 'Rekordbox USB Repair', 'Stick backups')

ipcMain.handle('plan-reformat', async (_event, volumePath: string, backupRoot?: string) => {
  const root = backupRoot ?? defaultStickBackupRoot()
  const { files: _files, ...plan } = await planReformat(volumePath, root)
  return { ...plan, backupRoot: root }
})

ipcMain.handle('choose-backup-folder', async () => {
  const r = await dialog.showOpenDialog({ title: 'Where should the stick backup go?', properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : (r.filePaths[0] ?? null)
})

ipcMain.handle('reformat-jobs', () => [...reformatJobs.values()])

function runReformatJob(
  sender: Electron.WebContents,
  job: ReformatJob,
  work: (onProgress: (p: ReformatProgress) => void) => Promise<ReformatResult>
): void {
  const send = (): void => {
    if (!sender.isDestroyed()) sender.send('reformat-update', job)
  }
  reformatJobs.set(job.id, job)
  send()
  work((p) => {
    job.progress = p
    send()
  })
    .then((result) => {
      job.result = result
    })
    .catch((err) => {
      job.error = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      job.running = false
      send()
    })
}

ipcMain.handle('start-reformat', async (event, volumePath: string, volumeName: string, backupRoot: string) => {
  if (await isRekordboxRunning()) {
    throw new Error('Rekordbox is currently running - please quit it, then try again')
  }
  if ([...reformatJobs.values()].some((j) => j.running)) throw new Error('Another stick is being reformatted - wait for it to finish')
  const job: ReformatJob = { id: randomUUID(), volumeName, volumePath, running: true }
  runReformatJob(event.sender, job, (onProgress) => reformatStick(volumePath, backupRoot, onProgress))
  return job.id
})

// After a failed copy-back: put the files from the backup onto the (already erased) stick again.
ipcMain.handle('restore-stick', async (event, jobId: string) => {
  const old = reformatJobs.get(jobId)
  if (!old?.result?.erased || old.running) throw new Error('Nothing to restore for this job')
  const prev = old.result
  const job: ReformatJob = { id: randomUUID(), volumeName: old.volumeName, volumePath: prev.volumePath, running: true }
  reformatJobs.delete(jobId)
  runReformatJob(event.sender, job, async (onProgress) => {
    const filesRestored = await restoreStickFromBackup(prev.backupPath, prev.volumePath, onProgress)
    return { ...prev, ok: true, message: undefined, filesRestored }
  })
  return job.id
})
