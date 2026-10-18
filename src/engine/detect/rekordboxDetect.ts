import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileAsync = promisify(execFile);

// Exact-match only (-x, not -f or -i substring matching) - a substring match
// previously matched this app's own dev process path, and separately would
// match this app's own product name ("Rekordbox USB Repair"), causing a
// permanent false-positive lockout even after real Rekordbox is closed.
// Checked as two separate exact matches (main app + its background Agent
// helper, which can outlive the main app's window) rather than one broader
// pattern, so neither can accidentally catch anything else.
export async function isRekordboxRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', 'rekordbox']);
    if (stdout.trim().length > 0) return true;
  } catch {
    // pgrep exits non-zero when no match is found - not an error condition.
  }
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', 'rekordboxAgent']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// 2. Original template install check
export function isRekordboxInstalled(): boolean {
  return existsSync('/Applications/rekordbox 6') || 
         existsSync('/Applications/rekordbox 7') || 
         existsSync('/Applications/rekordbox');
}

// 3. Original template app launcher utility
export async function openRekordbox(): Promise<void> {
  try {
    if (existsSync('/Applications/rekordbox 7')) {
      await execFileAsync('open', ['-a', 'rekordbox 7']);
    } else {
      await execFileAsync('open', ['-a', 'rekordbox']);
    }
  } catch (error) {
    console.error('Failed to open Rekordbox:', error);
  }
}
