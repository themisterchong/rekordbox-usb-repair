/**
 * Ported from fragmede/rekordbox-pdb (MIT License, Copyright (c) 2026 fragmede)
 * https://github.com/fragmede/rekordbox-pdb - src/rekordbox_pdb/pdb.py (decode_string)
 * and src/rekordbox_pdb/edit.py (encode_string).
 *
 * DeviceSQL string framing:
 * - Short ASCII: one odd length byte b, text length = (b >> 1) - 1, text follows.
 * - Long: a kind byte (0x40 ASCII / 0x90 UTF-16LE), a u16 total length that
 *   includes the 4-byte header, one zero byte, then the payload.
 */

/** Decode a DeviceSQL string starting at `off` within `buf`. */
export function decodeString(buf: Buffer, off: number): string {
  const b0 = buf[off]
  if (b0 === undefined) throw new RangeError(`decodeString: offset ${off} out of range`)
  if (b0 & 1) {
    // short ASCII: length byte covers itself, mangled *2+1
    const length = (b0 >> 1) - 1
    return buf.toString('ascii', off + 1, off + 1 + length)
  }
  const total = buf.readUInt16LE(off + 1)
  if (b0 === 0x40) {
    return buf.toString('ascii', off + 4, off + total)
  }
  if (b0 === 0x90) {
    return buf.toString('utf16le', off + 4, off + total)
  }
  throw new Error(`unknown DeviceSQL string kind ${b0.toString(16)} at offset ${off.toString(16)}`)
}

/** Total on-disk byte footprint of the DeviceSQL string starting at `off` (header + payload). */
export function stringByteLength(buf: Buffer, off: number): number {
  const b0 = buf[off]
  if (b0 === undefined) throw new RangeError(`stringByteLength: offset ${off} out of range`)
  if (b0 & 1) {
    const length = (b0 >> 1) - 1
    return 1 + length
  }
  return buf.readUInt16LE(off + 1) // already includes the 4-byte header, per the format
}

/** Encode a DeviceSQL string the way rekordbox does. */
export function encodeString(text: string): Buffer {
  const isAscii = /^[\x00-\x7F]*$/.test(text)
  if (!isAscii) {
    const payload = Buffer.from(text, 'utf16le')
    const header = Buffer.alloc(4)
    header.writeUInt8(0x90, 0)
    header.writeUInt16LE(payload.length + 4, 1)
    header.writeUInt8(0, 3)
    return Buffer.concat([header, payload])
  }
  const asciiBytes = Buffer.from(text, 'ascii')
  if (asciiBytes.length <= 126) {
    return Buffer.concat([Buffer.from([(asciiBytes.length + 1) * 2 + 1]), asciiBytes])
  }
  if (asciiBytes.length > 32763) {
    throw new Error('string too long for DeviceSQL encoding')
  }
  const header = Buffer.alloc(4)
  header.writeUInt8(0x40, 0)
  header.writeUInt16LE(asciiBytes.length + 4, 1)
  header.writeUInt8(0, 3)
  return Buffer.concat([header, asciiBytes])
}
