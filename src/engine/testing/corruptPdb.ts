/**
 * Deliberate corruption generator for export.pdb test fixtures - plan §6.
 * Takes a known-valid pdb buffer and produces a battery of corrupted
 * variants simulating different real failure patterns, so the repair
 * pipeline can be stress-tested against a range of severities without
 * depending on finding more real corrupted sticks.
 */

export interface CorruptionScenario {
  name: string
  description: string
  severity: 'light' | 'medium' | 'heavy' | 'structural'
  apply: (buf: Buffer) => Buffer
}

/** Cuts the file off at `fraction` of its length - the "yanked mid-write" case. */
function truncate(buf: Buffer, fraction: number): Buffer {
  return buf.subarray(0, Math.floor(buf.length * fraction))
}

/** Cuts off after a specific page boundary rather than an arbitrary byte. */
function truncateAtPage(buf: Buffer, pageIndex: number): Buffer {
  const pageSize = buf.readUInt32LE(4)
  return buf.subarray(0, pageIndex * pageSize)
}

/** Overwrites a byte range with zeros - a clean "never written" region. */
function zeroRegion(buf: Buffer, start: number, length: number): Buffer {
  const out = Buffer.from(buf)
  out.fill(0, start, Math.min(start + length, out.length))
  return out
}

/** Overwrites a byte range with pseudo-random bytes - messier than zeroing, closer to a real torn/overlapping write. */
function randomizeRegion(buf: Buffer, start: number, length: number, seed = 1): Buffer {
  const out = Buffer.from(buf)
  let x = seed
  const end = Math.min(start + length, out.length)
  for (let i = start; i < end; i++) {
    // Simple deterministic PRNG (xorshift) - reproducible across runs, no crypto needed.
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    x |= 0
    out[i] = x & 0xff
  }
  return out
}

export function buildCorruptionScenarios(validBuffer: Buffer): CorruptionScenario[] {
  const pageSize = validBuffer.readUInt32LE(4)
  const totalPages = Math.floor(validBuffer.length / pageSize)

  return [
    {
      name: 'truncate-99pct',
      description: 'Lose only the last 1% of pages - the lightest possible torn write',
      severity: 'light',
      apply: (buf) => truncate(buf, 0.99)
    },
    {
      name: 'truncate-90pct',
      description: 'Lose the last 10% of pages',
      severity: 'light',
      apply: (buf) => truncate(buf, 0.9)
    },
    {
      name: 'truncate-70pct',
      description: 'Lose the last 30% of pages',
      severity: 'medium',
      apply: (buf) => truncate(buf, 0.7)
    },
    {
      name: 'truncate-50pct',
      description: 'Lose the last half of the file',
      severity: 'medium',
      apply: (buf) => truncate(buf, 0.5)
    },
    {
      name: 'truncate-30pct',
      description: 'Only the first 30% of pages survive',
      severity: 'heavy',
      apply: (buf) => truncate(buf, 0.3)
    },
    {
      name: 'truncate-10pct',
      description: 'Only the first 10% of pages survive - severe torn write',
      severity: 'heavy',
      apply: (buf) => truncate(buf, 0.1)
    },
    {
      name: 'truncate-single-page',
      description: 'File cuts off after just one page past the header - worst-case truncation',
      severity: 'heavy',
      apply: (buf) => truncateAtPage(buf, 5)
    },
    {
      name: 'mid-file-zeroed-chunk',
      description: 'A 64KB chunk in the middle of the file (many pages) zeroed out, file length unchanged - simulates a write that landed in the wrong place, not just a clean cutoff',
      severity: 'medium',
      apply: (buf) => zeroRegion(buf, Math.floor(buf.length * 0.4), 65536)
    },
    {
      name: 'mid-file-random-garbage',
      description: 'Same region, but filled with pseudo-random bytes instead of zeros - messier, closer to real torn-write garbage',
      severity: 'medium',
      apply: (buf) => randomizeRegion(buf, Math.floor(buf.length * 0.4), 65536)
    },
    {
      name: 'single-page-garbled',
      description: 'Exactly one data page (not the first) filled with random bytes - smallest possible mid-file corruption',
      severity: 'light',
      apply: (buf) => randomizeRegion(buf, 20 * pageSize, pageSize, 7)
    },
    {
      name: 'table-directory-zeroed',
      description: 'The file header + entire table directory (first 512 bytes) zeroed - can we even locate anything?',
      severity: 'structural',
      apply: (buf) => zeroRegion(buf, 0, 512)
    },
    {
      name: 'table-directory-single-entry-scrambled',
      description: "Just the TRACKS table's own directory entry (16 bytes) randomized - header otherwise intact",
      severity: 'structural',
      apply: (buf) => randomizeRegion(buf, 0x1c, 16, 3)
    },
    {
      name: 'last-two-pages-zeroed',
      description: 'The very last two pages of the file zeroed (not removed) - a torn write that left garbage rather than stopping cleanly',
      severity: 'light',
      apply: (buf) => zeroRegion(buf, (totalPages - 2) * pageSize, 2 * pageSize)
    },
    {
      name: 'truncate-plus-mid-corruption',
      description: 'Combines truncation (last 20%) with a separate randomized chunk earlier in the surviving file - two independent problems at once',
      severity: 'heavy',
      apply: (buf) => randomizeRegion(truncate(buf, 0.8), Math.floor(buf.length * 0.3), 32768, 11)
    }
  ]
}
