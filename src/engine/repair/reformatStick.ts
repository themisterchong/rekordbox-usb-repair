import { execFile, spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { lstat, mkdir, readdir, readFile, statfs, utimes, writeFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'

/**
 * Fix a stick the player can't mount (see detect/stickFormat.ts): copy every file to the Mac,
 * erase the stick as FAT32 with an MBR partition table, and put every file back at the same
 * path, so the paths in export.pdb stay valid. Each file is hashed on the way out, again when
 * read back from the backup, and once more after it is written to the stick. The backup is
 * never deleted by this code.
 */

/** macOS bookkeeping, not part of the library. `._*` files would also show as broken tracks in
 * a player's folder view. */
const SKIP_NAMES = new Set(['.Spotlight-V100', '.fseventsd', '.Trashes', '.TemporaryItems', '.DocumentRevisions-V100', '.DS_Store'])
const FAT32_MAX_FILE = 4 * 1024 ** 3 - 1
const FAT_BAD_NAME = /[<>:"\\|?*\x00-\x1f]|[. ]$/

export interface ManifestEntry {
  path: string
  size: number
  mtimeMs: number
  sha256?: string
}

export interface ReformatPlan {
  volumePath: string
  wholeDisk: string
  newLabel: string
  fileCount: number
  totalBytes: number
  freeBytesOnMac: number
  /** Reasons it must not go ahead; empty = safe to start. */
  blockers: string[]
}

export interface ReformatProgress {
  step: 'backup' | 'erase' | 'restore' | 'verify'
  doneBytes: number
  totalBytes: number
}

export interface ReformatResult {
  ok: boolean
  /** true once the stick has been erased: from then on the files only exist in the backup. */
  erased: boolean
  backupPath: string
  volumePath: string
  message?: string
  filesRestored: number
}

/** A reformat running in the main process, as reported to the window. */
export interface ReformatJob {
  id: string
  volumeName: string
  volumePath: string
  running: boolean
  progress?: ReformatProgress
  result?: ReformatResult
  error?: string
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)
    )
  })
}

/** `diskutil ... -plist` output as JSON (via plutil), so nested lists can be read. */
function diskutilJson(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const du = spawn('diskutil', [args[0]!, '-plist', ...args.slice(1)])
    const pl = spawn('plutil', ['-convert', 'json', '-o', '-', '-'])
    du.stdout.pipe(pl.stdin)
    let out = ''
    pl.stdout.on('data', (d) => (out += d))
    pl.on('close', (code) => {
      if (code !== 0) return reject(new Error(`diskutil ${args.join(' ')} failed`))
      try {
        resolve(JSON.parse(out))
      } catch (e) {
        reject(e)
      }
    })
  })
}

/** FAT volume labels: up to 11 characters, upper case, a limited character set. */
export function fatLabel(name: string): string {
  const label = name
    .toUpperCase()
    .replace(/[^A-Z0-9 _-]/g, '_')
    .slice(0, 11)
    .trim()
  return label || 'REKORDBOX'
}

async function walk(root: string, problems: string[]): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = []
  async function visit(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      if (SKIP_NAMES.has(name) || name.startsWith('._')) continue
      const full = join(dir, name)
      const rel = relative(root, full)
      const st = await lstat(full)
      if (st.isSymbolicLink()) {
        problems.push(`"${rel}" is a link, which FAT32 can't store.`)
      } else if (st.isDirectory()) {
        if (FAT_BAD_NAME.test(name)) problems.push(`The folder name "${rel}" isn't allowed on FAT32.`)
        await visit(full)
      } else if (st.isFile()) {
        if (FAT_BAD_NAME.test(name)) problems.push(`The file name "${rel}" isn't allowed on FAT32.`)
        if (st.size > FAT32_MAX_FILE) problems.push(`"${rel}" is 4 GB or larger, too big for FAT32.`)
        out.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  await visit(root)
  return out
}

async function freeBytes(path: string): Promise<number> {
  await mkdir(path, { recursive: true })
  const s = await statfs(path)
  return s.bavail * s.bsize
}

export async function planReformat(volumePath: string, backupRoot: string): Promise<ReformatPlan & { files: ManifestEntry[] }> {
  const blockers: string[] = []
  const vol = await diskutilJson(['info', volumePath])
  const wholeDisk: string = vol.ParentWholeDisk || vol.DeviceIdentifier
  const whole = await diskutilJson(['info', wholeDisk])
  if (whole.Internal === true && whole.VirtualOrPhysical !== 'Virtual') blockers.push("This isn't a USB stick (it's an internal disk).")
  const list = await diskutilJson(['list', wholeDisk])
  const parts: { Content?: string; DeviceIdentifier: string }[] = list.AllDisksAndPartitions?.[0]?.Partitions ?? []
  const others = parts.filter((p) => p.DeviceIdentifier !== vol.DeviceIdentifier && p.Content !== 'EFI')
  if (others.length > 0) blockers.push('This stick has more than one partition. Erasing it would delete the others too.')

  const files = await walk(volumePath, blockers)
  const totalBytes = files.reduce((n, f) => n + f.size, 0)
  const freeBytesOnMac = await freeBytes(backupRoot)
  if (freeBytesOnMac < totalBytes + 1024 ** 3) {
    blockers.push(`Not enough free space on this Mac for the backup (needs ${gb(totalBytes + 1024 ** 3)}, ${gb(freeBytesOnMac)} free).`)
  }
  return {
    volumePath,
    wholeDisk,
    newLabel: fatLabel(vol.VolumeName || 'REKORDBOX'),
    fileCount: files.length,
    totalBytes,
    freeBytesOnMac,
    blockers,
    files
  }
}

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** Copies src to dest and returns the sha256 of what was read. */
async function copyHashed(src: string, dest: string, onBytes: (n: number) => void): Promise<string> {
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      onBytes(chunk.length)
      cb(null, chunk)
    }
  })
  await mkdir(dirname(dest), { recursive: true })
  await pipeline(createReadStream(src, { highWaterMark: 1024 * 1024 }), tap, createWriteStream(dest))
  return hash.digest('hex')
}

async function hashFile(path: string, onBytes: (n: number) => void): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer)
    onBytes((chunk as Buffer).length)
  }
  return hash.digest('hex')
}

function progressCounter(step: ReformatProgress['step'], totalBytes: number, onProgress: (p: ReformatProgress) => void) {
  let done = 0
  let last = 0
  return (n: number): void => {
    done += n
    const now = Date.now()
    if (now - last > 250 || done === totalBytes) {
      last = now
      onProgress({ step, doneBytes: done, totalBytes })
    }
  }
}

/** Puts every file from a backup back onto the (freshly erased) stick and verifies it there. */
export async function restoreStickFromBackup(
  backupPath: string,
  volumePath: string,
  onProgress: (p: ReformatProgress) => void
): Promise<number> {
  const manifest: ManifestEntry[] = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8')).files
  const total = manifest.reduce((n, f) => n + f.size, 0)
  const restoreTick = progressCounter('restore', total, onProgress)
  for (const f of manifest) {
    const sha = await copyHashed(join(backupPath, 'files', f.path), join(volumePath, f.path), restoreTick)
    if (sha !== f.sha256) throw new Error(`The backup copy of "${f.path}" doesn't match the original. Stopped.`)
    const t = f.mtimeMs / 1000
    await utimes(join(volumePath, f.path), t, t)
  }
  const verifyTick = progressCounter('verify', total, onProgress)
  for (const f of manifest) {
    if ((await hashFile(join(volumePath, f.path), verifyTick)) !== f.sha256) {
      throw new Error(`"${f.path}" didn't read back correctly from the stick.`)
    }
  }
  return manifest.length
}

export async function reformatStick(
  volumePath: string,
  backupRoot: string,
  onProgress: (p: ReformatProgress) => void
): Promise<ReformatResult> {
  const plan = await planReformat(volumePath, backupRoot)
  if (plan.blockers.length) throw new Error(plan.blockers.join(' '))

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupRoot, `${plan.newLabel} ${stamp}`)
  const result: ReformatResult = { ok: false, erased: false, backupPath, volumePath, filesRestored: 0 }

  // 1. Back up, hashing every file as it is read from the stick.
  const backupTick = progressCounter('backup', plan.totalBytes, onProgress)
  for (const f of plan.files) {
    f.sha256 = await copyHashed(join(volumePath, f.path), join(backupPath, 'files', f.path), backupTick)
  }
  await writeFile(join(backupPath, 'manifest.json'), JSON.stringify({ source: volumePath, label: plan.newLabel, files: plan.files }, null, 1))

  // 2. Erase as FAT32 + MBR. If this fails the stick is usually untouched (e.g. a file is in use).
  onProgress({ step: 'erase', doneBytes: 0, totalBytes: plan.totalBytes })
  try {
    await run('diskutil', ['eraseDisk', 'FAT32', plan.newLabel, 'MBRFormat', `/dev/${plan.wholeDisk}`])
  } catch (e) {
    return { ...result, message: `Couldn't erase the stick: ${(e as Error).message}. Your files are still on it, and backed up.` }
  }
  result.erased = true
  const part = (await diskutilJson(['list', plan.wholeDisk])).AllDisksAndPartitions?.[0]?.Partitions?.[0]?.DeviceIdentifier
  const info = part ? await diskutilJson(['info', part]) : null
  if (!info?.MountPoint) {
    return { ...result, message: "The stick was erased but didn't mount again. Replug it, then put the files back from the backup." }
  }
  result.volumePath = info.MountPoint

  // 3. Put everything back and verify it on the stick.
  try {
    result.filesRestored = await restoreStickFromBackup(backupPath, result.volumePath, onProgress)
  } catch (e) {
    return { ...result, message: (e as Error).message }
  }
  return { ...result, ok: true }
}
