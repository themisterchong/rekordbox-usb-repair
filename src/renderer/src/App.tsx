import { useEffect, useState, useCallback } from 'react'
import type { VolumeExports } from '../../engine/detect/formatDetect'
import type { StickFormatReport } from '../../engine/detect/stickFormat'
import type { ReformatJob, ReformatProgress } from '../../engine/repair/reformatStick'
import type { FormatHealth } from '../../engine/repair/checkHealth'
import type { Tier0RepairResult } from '../../engine/repair/tier0PdbRepair'
import type { StandaloneSalvageResult } from '../../engine/repair/standaloneSalvage'
import type { RegenerateOneLibraryResult } from '../../engine/repair/regenerateOneLibrary'
import type { RelinkStalePathsResult } from '../../engine/repair/relinkStalePaths'

interface RekordboxStatus {
  installed: boolean
  running: boolean
}

const POLL_INTERVAL_MS = 2000
const HEALTH_CHECK_TIMEOUT_MS = 15000

/**
 * A health check can hang on a drive that's actively being written to by
 * Rekordbox itself (observed: SQLite lock contention on a live
 * exportLibrary.db) - without a bound, that leaves the card on
 * "Checking..." forever with no way out except relaunching the app.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms)
    promise.then((result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}

type RepairState =
  | { phase: 'idle' }
  | { phase: 'repairing' }
  | { phase: 'done'; result: Tier0RepairResult }
  | { phase: 'error'; message: string }

type SalvageState =
  | { phase: 'idle' }
  | { phase: 'salvaging' }
  | { phase: 'done'; result: StandaloneSalvageResult }
  | { phase: 'error'; message: string }

type RegenerateState =
  | { phase: 'idle' }
  | { phase: 'regenerating' }
  | { phase: 'done'; result: RegenerateOneLibraryResult }
  | { phase: 'error'; message: string }

type RelinkState =
  | { phase: 'idle' }
  | { phase: 'relinking' }
  | { phase: 'done'; result: RelinkStalePathsResult }
  | { phase: 'error'; message: string }

function RelinkPanel({
  pdbPath,
  stalePathCount,
  volume,
  rekordbox,
  onDone
}: {
  pdbPath: string
  stalePathCount: number
  volume: VolumeExports
  rekordbox: RekordboxStatus | null
  onDone: () => void
}): React.JSX.Element {
  const [relink, setRelink] = useState<RelinkState>({ phase: 'idle' })

  const doRelink = useCallback(async () => {
    setRelink({ phase: 'relinking' })
    try {
      const result = await window.repairTool.relinkStalePaths({
        rekordboxDir: volume.rekordboxDir,
        volumeName: volume.volumeName,
        volumePath: volume.volumePath,
        pdbPath
      })
      setRelink({ phase: 'done', result })
      onDone()
    } catch (err) {
      setRelink({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [pdbPath, volume, onDone])

  if (relink.phase === 'idle') {
    return (
      <div className="issue-panel">
        <p className="disclaimer">Searches this stick for the missing files and fixes the links.</p>
        {/* Rekordbox-running state already has its own banner at the top
            of the app - repeating it here would just be noise. */}
        {!rekordbox?.running && <button onClick={doRelink}>Find {stalePathCount} missing file{stalePathCount === 1 ? "" : "s"}</button>}
      </div>
    )
  }

  if (relink.phase === 'relinking') {
    return <p className="status">Searching this drive for the missing files...</p>
  }

  if (relink.phase === 'error') {
    return <p className="bad">Relink failed: {relink.message}</p>
  }

  const r = relink.result
  return (
    <div className="result">
      <p className={r.verified && r.relinked > 0 ? 'ok' : 'note'}>
        {r.relinked} of {r.staleFound} track{r.staleFound === 1 ? '' : 's'} relinked automatically.
      </p>
      {r.unresolved.length > 0 && (
        <p className="note">{r.unresolved.length} still missing (not on this stick).</p>
      )}
      <details className="more"><summary>Backups</summary><ul className="backups">
        <li>{r.usbBackupPath}</li>
        <li>{r.localBackupPath}</li>
      </ul></details>
    </div>
  )
}

type ReformatPlanView = Awaited<ReturnType<typeof window.repairTool.planReformat>>

type ReformatPanelState =
  | { phase: 'idle' }
  | { phase: 'planning' }
  | { phase: 'confirm'; plan: ReformatPlanView }
  | { phase: 'error'; message: string }

function gb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** Offered when the stick itself is formatted wrong: back up, erase as FAT32 (MBR), put it all back. */
function ReformatPanel({ volume, rekordbox }: { volume: VolumeExports; rekordbox: RekordboxStatus | null }): React.JSX.Element {
  const [state, setState] = useState<ReformatPanelState>({ phase: 'idle' })

  const plan = useCallback(
    async (backupRoot?: string) => {
      setState({ phase: 'planning' })
      try {
        setState({ phase: 'confirm', plan: await window.repairTool.planReformat(volume.volumePath, backupRoot) })
      } catch (err) {
        setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [volume.volumePath]
  )

  const changeFolder = useCallback(async () => {
    const folder = await window.repairTool.chooseBackupFolder()
    if (folder) await plan(folder)
  }, [plan])

  const start = useCallback(async (p: ReformatPlanView) => {
    try {
      await window.repairTool.startReformat(volume.volumePath, volume.volumeName, p.backupRoot)
      setState({ phase: 'idle' })
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [volume])

  if (state.phase === 'planning') return <p className="status">Looking at everything on the stick…</p>
  if (state.phase === 'error') return <p className="bad">{state.message}</p>

  if (state.phase === 'confirm') {
    const p = state.plan
    return (
      <div className="issue-panel">
        <ul className="plan">
          <li><span>On the stick</span><b>{p.fileCount} files, {gb(p.totalBytes)}</b></li>
          <li><span>Backup to</span><b className="path">{p.backupRoot}</b></li>
          <li><span>Free there</span><b>{gb(p.freeBytesOnMac)}</b></li>
          <li><span>New format</span><b>FAT32 (MBR), name {p.newLabel}</b></li>
        </ul>
        {p.blockers.length > 0 ? (
          <>
            <p className="bad">Can&apos;t do this safely:</p>
            <ul className="blocker-list">{p.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            <div className="actions">
              <button className="secondary" onClick={changeFolder}>Change backup folder…</button>
              <button className="secondary" onClick={() => setState({ phase: 'idle' })}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p className="disclaimer">
              Everything is copied to the backup folder and checked first. Then the stick is erased and every file is
              put back in the same place and checked again. The backup is kept until you delete it.
            </p>
            <div className="actions">
              {!rekordbox?.running && <button className="danger" onClick={() => start(p)}>Erase and reformat</button>}
              <button className="secondary" onClick={changeFolder}>Change backup folder…</button>
              <button className="secondary" onClick={() => setState({ phase: 'idle' })}>Cancel</button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="issue-panel">
      <p className="disclaimer">Copies everything to this Mac, reformats the stick as FAT32 and puts it all back.</p>
      {!rekordbox?.running && <button onClick={() => plan()}>Fix stick format…</button>}
    </div>
  )
}

const REFORMAT_STEP_LABEL: Record<ReformatProgress['step'], string> = {
  backup: 'Copying to the backup',
  erase: 'Erasing the stick',
  restore: 'Putting files back',
  verify: 'Checking every file on the stick'
}

/** Lives outside the stick cards: the stick unmounts (and may be renamed) while it is erased. */
function ReformatJobPanel({ job, onDismiss }: { job: ReformatJob; onDismiss: () => void }): React.JSX.Element {
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const r = job.result
  if (job.running) {
    const p = job.progress
    const pct = p && p.totalBytes > 0 && p.step !== 'erase' ? Math.floor((p.doneBytes / p.totalBytes) * 100) : null
    return (
      <div className="job-panel">
        <strong>Reformatting {job.volumeName}</strong>
        <p className="status">
          {p ? REFORMAT_STEP_LABEL[p.step] : 'Starting'}
          {pct !== null ? ` — ${pct}%` : '…'}
        </p>
        <div className="progress"><i style={{ width: `${pct ?? 0}%` }} /></div>
        <p className="note">Don&apos;t unplug the stick.</p>
      </div>
    )
  }
  return (
    <div className="job-panel">
      <strong>{job.volumeName}</strong>
      {r?.ok ? (
        <p className="ok">Reformatted as FAT32 (MBR). All {r.filesRestored} files are back and checked.</p>
      ) : (
        <p className="bad">{job.error ?? r?.message ?? 'Reformat failed.'}</p>
      )}
      {r && !r.ok && r.erased && (
        <>
          <p className="note">Your files are safe in the backup.</p>
          {restoreError && <p className="bad">{restoreError}</p>}
          <button onClick={() => window.repairTool.restoreStick(job.id).catch((e) => setRestoreError(String(e)))}>Put files back</button>
        </>
      )}
      {r && <details className="more"><summary>Backup</summary><ul className="backups"><li>{r.backupPath}</li></ul></details>}
      <button className="secondary" onClick={onDismiss}>Close</button>
    </div>
  )
}

function VolumeCard({
  volume,
  rekordbox,
  checkGeneration,
  reformatBusy
}: {
  volume: VolumeExports
  rekordbox: RekordboxStatus | null
  checkGeneration: number
  reformatBusy: boolean
}): React.JSX.Element {
  const [health, setHealth] = useState<Record<string, FormatHealth>>({})
  const [checking, setChecking] = useState(true)
  const [repair, setRepair] = useState<RepairState>({ phase: 'idle' })
  const [salvage, setSalvage] = useState<SalvageState>({ phase: 'idle' })
  const [regenerate, setRegenerate] = useState<RegenerateState>({ phase: 'idle' })
  const [recheck, setRecheck] = useState(0)
  const [stickFormat, setStickFormat] = useState<StickFormatReport | null>(null)

  useEffect(() => {
    let cancelled = false

    async function checkAll(): Promise<void> {
      setChecking(true)
      window.repairTool.checkStickFormat(volume.volumePath).then((r) => {
        if (!cancelled) setStickFormat(r)
      })
      const results = await Promise.all(
        volume.exports.map((e) =>
          withTimeout(window.repairTool.checkExportHealth(e, volume.volumePath), HEALTH_CHECK_TIMEOUT_MS, () => ({
            format: e.format,
            path: e.path,
            healthy: false,
            issues: ['Timed out checking this file - it may be locked by Rekordbox or another app. Try "Check again".'],
            trackCount: null,
            stalePathCount: null
          }))
        )
      )
      if (!cancelled) {
        const byPath: Record<string, FormatHealth> = {}
        for (const r of results) byPath[r.path] = r
        setHealth(byPath)
        setChecking(false)
      }
    }
    checkAll()
    return () => {
      cancelled = true
    }
    // volume.volumePath (not the whole volume object, which is a fresh
    // reference on every 2s poll) plus checkGeneration - so this only
    // re-runs on a genuinely new drive or an explicit "Check again" click,
    // never on every routine poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume.volumePath, checkGeneration, recheck])

  const pdb = volume.exports.find((e) => e.format === 'export.pdb')
  const oneLib = volume.exports.find((e) => e.format === 'exportLibrary.db')
  const pdbHealth = pdb ? health[pdb.path] : undefined
  const oneLibHealth = oneLib ? health[oneLib.path] : undefined

  // Tier 0 is the only corruption-repair path built so far: pdb
  // corrupted, its exportLibrary.db sibling healthy. Anything else, we
  // say so honestly rather than pretend to offer a fix that doesn't exist yet.
  const canRepairViaTier0 = !!(pdb && oneLib && pdbHealth && !pdbHealth.healthy && oneLibHealth?.healthy)
  // Standalone salvage covers everything Tier 0 can't reach: no
  // exportLibrary.db sibling on the drive at all (a newer, optional
  // format many real sticks never had), or it's also corrupted. No
  // healthy reference is used - this exactly partitions the "pdb
  // corrupted" space against canRepairViaTier0 above, so the two never
  // both apply.
  const canRepairViaStandaloneSalvage = !!(pdb && pdbHealth && !pdbHealth.healthy && (!oneLib || oneLibHealth?.healthy === false))
  // Once the pdb is healthy (always was, or was just fixed above), a
  // missing-or-corrupted exportLibrary.db can be regenerated FROM it -
  // the reverse of Tier 0's direction. Experimental: never validated
  // against real Rekordbox software, only this project's own reader.
  const canRegenerateOneLibrary = !!(pdb && pdbHealth?.healthy && (!oneLib || oneLibHealth?.healthy === false))
  const hasStalePaths = !!(pdb && pdbHealth?.healthy && (pdbHealth.stalePathCount ?? 0) > 0)
  // Healthy for desktop parsers, but long/UTF-16 names sit off a 4-byte boundary: freezes the
  // XDJ-700 (and some CDJs) on insert. A rebuild writes them aligned, as rekordbox does.
  const misaligned = pdbHealth?.healthy ? (pdbHealth.misalignedStrings ?? 0) : 0
  const canMakeCdjSafe = !!(pdb && misaligned > 0 && !canRepairViaStandaloneSalvage && !canRepairViaTier0)

  const doRepair = useCallback(async () => {
    if (!pdb || !oneLib) return
    setRepair({ phase: 'repairing' })
    try {
      const result = await window.repairTool.repairTier0({
        rekordboxDir: volume.rekordboxDir,
        volumeName: volume.volumeName,
        corruptedPdbPath: pdb.path,
        healthyOneLibraryPath: oneLib.path
      })
      setRepair({ phase: 'done', result })
      // The atomic rename in repairPdbViaTier0 means pdb.path now points at
      // the verified, repaired file - re-check it so the format list above
      // stops showing the pre-repair "corrupted" status once it's fixed.
      if (result.verified) {
        const refreshed = await window.repairTool.checkExportHealth(pdb, volume.volumePath)
        setHealth((prev) => ({ ...prev, [pdb.path]: refreshed }))
      }
    } catch (err) {
      setRepair({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [pdb, oneLib, volume])

  const doSalvage = useCallback(async () => {
    if (!pdb) return
    setSalvage({ phase: 'salvaging' })
    try {
      const result = await window.repairTool.repairStandaloneSalvage({
        rekordboxDir: volume.rekordboxDir,
        volumeName: volume.volumeName,
        corruptedPdbPath: pdb.path
      })
      setSalvage({ phase: 'done', result })
      if (result.verified) {
        const refreshed = await window.repairTool.checkExportHealth(pdb, volume.volumePath)
        setHealth((prev) => ({ ...prev, [pdb.path]: refreshed }))
      }
    } catch (err) {
      setSalvage({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [pdb, volume])

  const doRegenerate = useCallback(async () => {
    if (!pdb) return
    setRegenerate({ phase: 'regenerating' })
    try {
      const result = await window.repairTool.regenerateOneLibrary({
        rekordboxDir: volume.rekordboxDir,
        volumeName: volume.volumeName,
        healthyPdbPath: pdb.path
      })
      setRegenerate({ phase: 'done', result })
      if (result.verified && result.appliedPath) {
        const refreshed = await window.repairTool.checkExportHealth(
          { format: 'exportLibrary.db', path: result.appliedPath },
          volume.volumePath
        )
        setHealth((prev) => ({ ...prev, [result.appliedPath!]: refreshed }))
      }
    } catch (err) {
      setRegenerate({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [pdb, volume])

  const allHealthy = checking ? null : volume.exports.every((e) => health[e.path]?.healthy) && !hasStalePaths && misaligned === 0 && stickFormat?.ok !== false

  // One plain verdict for the whole stick, worst problem first.
  const verdict: { tone: 'good' | 'warn' | 'bad'; title: string; text: string } | null = checking || !pdb || !pdbHealth
    ? null
    : stickFormat?.ok === false
      ? { tone: 'bad', title: "Players can't read this stick", text: stickFormat.problem ?? '' }
      : !pdbHealth.healthy
      ? { tone: 'bad', title: 'Damaged', text: 'The database is broken.' }
      : misaligned > 0
        ? { tone: 'bad', title: 'Will freeze older players', text: 'This stick can freeze an XDJ-700 or older CDJ.' }
        : hasStalePaths
          ? { tone: 'warn', title: 'Missing files', text: `${pdbHealth.stalePathCount} tracks can't find their music file.` }
          : { tone: 'good', title: 'Safe for CDJ/XDJ', text: 'Ready to play.' }

  return (
    <li className={`volume${verdict ? ` tone-${verdict.tone}` : ''}`}>
      <div className="volume-header">
        <span className={`status-dot ${checking ? 'pending' : allHealthy ? 'good' : 'issue'}`} />
        <strong>{volume.volumeName}</strong>
        {pdbHealth?.trackCount != null && <span className="track-count">{pdbHealth.trackCount} tracks</span>}
      </div>

      {verdict && (
        <div className={`verdict verdict-${verdict.tone}`}>
          <strong>{verdict.title}</strong>
          <span>{verdict.text}</span>
        </div>
      )}

      {checking && <p className="status">Checking…</p>}

      {stickFormat?.ok === false && !reformatBusy && <ReformatPanel volume={volume} rekordbox={rekordbox} />}

      {repair.phase === 'idle' && canRepairViaTier0 && (
        <div className="issue-panel">
          <p className="disclaimer">Rebuilds it from the healthy copy on this stick.</p>
          {/* Rekordbox-running state already has its own banner at the top
              of the app - repeating it here would just be noise. */}
          {!rekordbox?.running && <button onClick={doRepair}>Repair</button>}
        </div>
      )}

      {salvage.phase === 'idle' && canRepairViaStandaloneSalvage && (
        <div className="issue-panel">
          <p className="disclaimer">Rebuilds it from whatever is still readable.</p>
          {!rekordbox?.running && <button onClick={doSalvage}>Repair</button>}
        </div>
      )}

      {salvage.phase === 'idle' && canMakeCdjSafe && (
        <div className="issue-panel">
          <p className="disclaimer">Rewrites the database so players can read it. Nothing is lost.</p>
          {!rekordbox?.running && <button onClick={doSalvage}>Make CDJ-safe</button>}
        </div>
      )}

      {salvage.phase === 'salvaging' && <p className="status">Backing up, then repairing…</p>}
      {salvage.phase === 'error' && <p className="bad">Recovery failed: {salvage.message}</p>}

      {salvage.phase === 'done' && (
        <div className="result">
          <p className={salvage.result.verified ? 'ok' : 'bad'}>
            {salvage.result.verified
              ? `Done — ${salvage.result.tracksAfter} tracks.`
              : 'Verification failed — nothing was changed on your drive.'}
          </p>
          {salvage.result.verified && (
            <ul className="recovered-breakdown">
              {salvage.result.tracksRecovered > 0 && <li>{salvage.result.tracksRecovered} track(s)</li>}
              {salvage.result.artistsRecovered > 0 && <li>{salvage.result.artistsRecovered} artist(s)</li>}
              {salvage.result.albumsRecovered > 0 && <li>{salvage.result.albumsRecovered} album(s)</li>}
              {salvage.result.genresRecovered > 0 && <li>{salvage.result.genresRecovered} genre(s)</li>}
              {salvage.result.labelsRecovered > 0 && <li>{salvage.result.labelsRecovered} label(s)</li>}
              {salvage.result.keysRecovered > 0 && <li>{salvage.result.keysRecovered} key(s)</li>}
              {salvage.result.playlistsRecovered > 0 && <li>{salvage.result.playlistsRecovered} playlist(s)</li>}
              {salvage.result.playlistEntriesRecovered > 0 && (
                <li>{salvage.result.playlistEntriesRecovered} playlist entrie(s)</li>
              )}
            </ul>
          )}
          <details className="more"><summary>Backups</summary><ul className="backups">
            <li>{salvage.result.usbBackupPath}</li>
            <li>{salvage.result.localBackupPath}</li>
          </ul></details>
        </div>
      )}

      {regenerate.phase === 'idle' && canRegenerateOneLibrary && misaligned === 0 && !hasStalePaths && (
        <details className="more">
          <summary>More options</summary>
          <p className="disclaimer">
            Rebuild exportLibrary.db (for newer players) from export.pdb. Experimental; hot cues, history and My Tags
            can&apos;t be recovered this way.
          </p>
          {!rekordbox?.running && <button className="secondary" onClick={doRegenerate}>Rebuild exportLibrary.db</button>}
        </details>
      )}

      {regenerate.phase === 'regenerating' && <p className="status">Rebuilding exportLibrary.db from export.pdb...</p>}
      {regenerate.phase === 'error' && <p className="bad">Rebuild failed: {regenerate.message}</p>}

      {regenerate.phase === 'done' && (
        <div className="result">
          <p className={regenerate.result.verified ? 'ok' : 'bad'}>
            {regenerate.result.verified
              ? `Rebuilt exportLibrary.db — ${regenerate.result.tracksWritten} tracks, ${regenerate.result.playlistsWritten} playlists.`
              : 'Verification failed — nothing was changed on your drive.'}
          </p>
          {(regenerate.result.usbBackupPath || regenerate.result.localBackupPath) && (
            <>
              <details className="more"><summary>Backups</summary><ul className="backups">
                {regenerate.result.usbBackupPath && <li>{regenerate.result.usbBackupPath}</li>}
                {regenerate.result.localBackupPath && <li>{regenerate.result.localBackupPath}</li>}
              </ul></details>
            </>
          )}
        </div>
      )}

      {repair.phase === 'repairing' && <p className="status">Backing up, then repairing…</p>}
      {repair.phase === 'error' && <p className="bad">Repair failed: {repair.message}</p>}

      {repair.phase === 'done' && (
        <div className="result">
          <p className={repair.result.verified ? 'ok' : 'bad'}>
            {repair.result.verified
              ? `Done — ${repair.result.tracksAfter} tracks.`
              : 'Verification failed — nothing was changed on your drive.'}
          </p>
          {repair.result.verified && (
            <ul className="recovered-breakdown">
              {repair.result.tracksRecovered > 0 && <li>{repair.result.tracksRecovered} track(s)</li>}
              {repair.result.artistsRecovered > 0 && <li>{repair.result.artistsRecovered} artist(s)</li>}
              {repair.result.albumsRecovered > 0 && <li>{repair.result.albumsRecovered} album(s)</li>}
              {repair.result.genresRecovered > 0 && <li>{repair.result.genresRecovered} genre(s)</li>}
              {repair.result.labelsRecovered > 0 && <li>{repair.result.labelsRecovered} label(s)</li>}
              {repair.result.keysRecovered > 0 && <li>{repair.result.keysRecovered} key(s)</li>}
              {repair.result.playlistsRecovered > 0 && <li>{repair.result.playlistsRecovered} playlist(s)</li>}
              {repair.result.playlistEntriesRecovered > 0 && (
                <li>{repair.result.playlistEntriesRecovered} playlist entrie(s)</li>
              )}
            </ul>
          )}
          <details className="more"><summary>Backups</summary><ul className="backups">
            <li>{repair.result.usbBackupPath}</li>
            <li>{repair.result.localBackupPath}</li>
          </ul></details>
        </div>
      )}

      {hasStalePaths && pdb && repair.phase === 'idle' && misaligned === 0 && (
        <RelinkPanel pdbPath={pdb.path} stalePathCount={pdbHealth!.stalePathCount!} volume={volume} rekordbox={rekordbox} onDone={() => setRecheck((n) => n + 1)} />
      )}
    </li>
  )
}

function App(): React.JSX.Element {
  const [volumes, setVolumes] = useState<VolumeExports[]>([])
  const [rekordbox, setRekordbox] = useState<RekordboxStatus | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [checkGeneration, setCheckGeneration] = useState(0)
  const [jobs, setJobs] = useState<ReformatJob[]>([])

  useEffect(() => {
    window.repairTool.reformatJobs().then(setJobs)
    return window.repairTool.onReformatUpdate((job) => {
      setJobs((prev) => [...prev.filter((j) => j.id !== job.id && !(job.running && j.volumePath === job.volumePath && !j.running)), job])
      if (!job.running) setCheckGeneration((g) => g + 1)
    })
  }, [])
  const busyPaths = new Set(jobs.filter((j) => j.running).map((j) => j.volumePath))

  const poll = useCallback(async (): Promise<void> => {
    const [found, status] = await Promise.all([window.repairTool.scanForExports(), window.repairTool.rekordboxStatus()])
    setVolumes(found)
    setRekordbox(status)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function tick(): Promise<void> {
      if (!cancelled) await poll()
    }
    tick()
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [poll])

  const handleRecheck = useCallback(async (): Promise<void> => {
    setRechecking(true)
    try {
      await poll()
      setCheckGeneration((g) => g + 1)
    } finally {
      setRechecking(false)
    }
  }, [poll])

  return (
    <main>
      <div className="titlebar" />
      <header className="app-header">
        <div className="mark">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="6" width="2" height="4" rx="1" fill="#ff9d2e" />
            <rect x="5" y="3" width="2" height="10" rx="1" fill="#ff9d2e" />
            <rect x="9" y="1" width="2" height="14" rx="1" fill="#ff9d2e" />
            <rect x="13" y="5" width="2" height="6" rx="1" fill="#ff9d2e" />
          </svg>
        </div>
        <div>
          <h1 className="app-title">Rekordbox USB Repair</h1>
          <p className="tagline">Fix rekordbox USB sticks. Your original is always backed up first.</p>
        </div>
      </header>

      {/* Independent of any per-drive health check, which can take a while
          (or, in a stuck/slow case, never finish) - this must never be
          hidden behind that, since it's the first line of the safety gate. */}
      {rekordbox?.running && <p className="blocker top-blocker">Rekordbox is currently open — please quit it, then check again.</p>}

      <div className="content">
      {jobs.map((j) => (
        <ReformatJobPanel key={j.id} job={j} onDismiss={() => setJobs((prev) => prev.filter((x) => x.id !== j.id))} />
      ))}
      {volumes.length === 0 ? (
        <div className="empty-state">
          <p className="status">Plug in a USB stick or SD card with a Rekordbox export to check it.</p>
        </div>
      ) : (
        <ul className="volumes">
          {volumes.map((v) => (
            <VolumeCard key={v.volumePath} volume={v} rekordbox={rekordbox} checkGeneration={checkGeneration} reformatBusy={busyPaths.has(v.volumePath)} />
          ))}
        </ul>
      )}
      </div>

      {rekordbox && (
        <footer>
          <button className="secondary" onClick={handleRecheck} disabled={rechecking}>
            {rechecking ? 'Checking…' : 'Check'}
          </button>
          {rekordbox.installed ? (
            <button className="secondary" onClick={() => window.repairTool.openRekordbox()}>
              Open Rekordbox
            </button>
          ) : (
            <span className="muted">Rekordbox not installed on this Mac</span>
          )}
        </footer>
      )}
    </main>
  )
}

export default App
