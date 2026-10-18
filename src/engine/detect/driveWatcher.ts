import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface VolumeExports {
  path: string;
  name: string;
  isCorrupted: boolean;
}

export function scanMountedVolumesForExports(): VolumeExports[] {
  const VOLUMES_ROOT = '/Volumes';
  const found: VolumeExports[] = [];

  try {
    const entries = readdirSync(VOLUMES_ROOT).filter(name => !name.startsWith('.'));

    for (const name of entries) {
      const volumePath = join(VOLUMES_ROOT, name);
      
      // Zero filtering on contents. If it is a mounted storage device, show it!
      if (name.toLowerCase() === 'usb' || existsSync(join(volumePath, 'PIONEER'))) {
        found.push({
          path: volumePath,
          name: name,
          isCorrupted: false // Keep it false so the UI remains stable and lets you interact with it
        });
      }
    }
  } catch (error) {
    console.error("Error running basic volume scan:", error);
  }

  return found;
}
