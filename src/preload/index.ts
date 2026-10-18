import { contextBridge, ipcRenderer } from 'electron'
import type { VolumeExports, DetectedExport } from '../engine/detect/formatDetect'
import type { FormatHealth } from '../engine/repair/checkHealth'
import type { StickFormatReport } from '../engine/detect/stickFormat'
import type { ReformatJob, ReformatPlan } from '../engine/repair/reformatStick'
import type { Tier0RepairResult, Tier0RepairRequest } from '../engine/repair/tier0PdbRepair'
import type { StandaloneSalvageResult, StandaloneSalvageRequest } from '../engine/repair/standaloneSalvage'
import type { RegenerateOneLibraryResult, RegenerateOneLibraryRequest } from '../engine/repair/regenerateOneLibrary'
import type { RelinkStalePathsResult, RelinkRequest } from '../engine/repair/relinkStalePaths'

const api = {
  scanForExports: (): Promise<VolumeExports[]> => ipcRenderer.invoke('scan-for-exports'),
  checkExportHealth: (detected: DetectedExport, volumePath?: string): Promise<FormatHealth> =>
    ipcRenderer.invoke('check-export-health', detected, volumePath),
  checkStickFormat: (volumePath: string): Promise<StickFormatReport> => ipcRenderer.invoke('check-stick-format', volumePath),
  planReformat: (volumePath: string, backupRoot?: string): Promise<ReformatPlan & { backupRoot: string }> =>
    ipcRenderer.invoke('plan-reformat', volumePath, backupRoot),
  chooseBackupFolder: (): Promise<string | null> => ipcRenderer.invoke('choose-backup-folder'),
  startReformat: (volumePath: string, volumeName: string, backupRoot: string): Promise<string> =>
    ipcRenderer.invoke('start-reformat', volumePath, volumeName, backupRoot),
  restoreStick: (jobId: string): Promise<string> => ipcRenderer.invoke('restore-stick', jobId),
  reformatJobs: (): Promise<ReformatJob[]> => ipcRenderer.invoke('reformat-jobs'),
  onReformatUpdate: (cb: (job: ReformatJob) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, job: ReformatJob): void => cb(job)
    ipcRenderer.on('reformat-update', listener)
    return () => ipcRenderer.removeListener('reformat-update', listener)
  },
  rekordboxStatus: (): Promise<{ installed: boolean; running: boolean }> =>
    ipcRenderer.invoke('rekordbox-status'),
  openRekordbox: (): Promise<void> => ipcRenderer.invoke('open-rekordbox'),
  repairTier0: (params: Tier0RepairRequest): Promise<Tier0RepairResult> => ipcRenderer.invoke('repair-tier0', params),
  repairStandaloneSalvage: (params: StandaloneSalvageRequest): Promise<StandaloneSalvageResult> =>
    ipcRenderer.invoke('repair-standalone-salvage', params),
  regenerateOneLibrary: (params: RegenerateOneLibraryRequest): Promise<RegenerateOneLibraryResult> =>
    ipcRenderer.invoke('regenerate-onelibrary', params),
  relinkStalePaths: (params: RelinkRequest): Promise<RelinkStalePathsResult> =>
    ipcRenderer.invoke('relink-stale-paths', params)
}

export type RepairToolApi = typeof api

contextBridge.exposeInMainWorld('repairTool', api)
