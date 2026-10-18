# Rekordbox USB Repair

Fixes Rekordbox DJ USB sticks that freeze or get rejected by Pioneer / AlphaTheta players, and repairs corrupted device exports (`export.pdb`, `exportLibrary.db`). It never changes the original file. Every repair makes a verified backup first.

Not affiliated with AlphaTheta or Pioneer DJ.

## What it found

**XDJ-700 freeze on insert = misaligned strings in `export.pdb`.** Every long text string (UTF-16 or long ASCII: titles, artists, albums, and so on) must start on a 4-byte boundary in the file. Rekordbox always writes them that way. Some third-party writers don't, and the XDJ-700 (firmware 1.15) then freezes on insert or at the "MY SETTINGS DATA was found" prompt. The CDJ-2000NXS2 freezes the same way ([baken#168](https://github.com/M-Igashi/baken/issues/168)). Confirmed on two real XDJ-700s with the [A/B test kit](https://github.com/themisterchong/xdj700-freeze-testkit) ([rbxport#483](https://github.com/chrisle/rbxport/issues/483)): aligned file loads, unaligned file freezes instantly.

**"FORMAT USB" on an XDJ-700 = wrong partition type, not missing files.** The player only mounts FAT partitions. An MBR partition with type `0x83` (Linux, `fdisk`'s default) shows FORMAT USB even with a valid export. Changing the type to `0x0c` (W95 FAT32 LBA) fixed it on real hardware. GPT-partitioned sticks show FORMAT USB in emulation of the real firmware too (not yet confirmed on hardware).

Fix the partition type on Linux:

```sh
sudo fdisk /dev/sdX      # t -> c -> w   (W95 FAT32 LBA)
sudo mkfs.vfat -F32 /dev/sdX1    # only if the partition isn't FAT32 yet - this erases it
```

## Make an export CDJ-safe (macOS, Linux, Windows)

Needs only [Node.js](https://nodejs.org) 20 or newer. No install step.

```sh
git clone https://github.com/themisterchong/rekordbox-usb-repair
cd rekordbox-usb-repair
npx tsx cli/make-cdj-safe.ts /path/to/stick/PIONEER/rekordbox/export.pdb ~/export-fixed.pdb
```

It rebuilds the file with every string aligned and keeps all tracks, playlists and ids. It checks the result (re-reads it, compares track and playlist counts, re-checks alignment) and writes nothing if anything is off. The input file is never touched.

Then:

1. Back up the stick's whole `PIONEER` folder (on a Mac-formatted stick it's `.PIONEER`).
2. Copy the fixed file onto the stick as `PIONEER/rekordbox/export.pdb`.
3. Eject properly and try it in the player.

Verified: rebuilding the test kit's unaligned file B gives a file byte-identical to the aligned file A, which loads on real XDJ-700s.

## The Mac app

An Electron app that does the same thing with buttons, plus:

- **Health check** per stick: damaged / will freeze older players / missing files / safe.
- **Make CDJ-safe**: the rebuild above, with backups and an atomic swap.
- **Stick format check**: flags GPT, non-FAT partition types, exFAT/NTFS/APFS, HFS+ without `.PIONEER`.
- **Fix stick format**: backs up the whole stick (SHA-256 checked), reformats it as FAT32 on MBR, restores everything and verifies it. Not yet tested on a real stick.
- **Corrupted export repair**: rebuilds a broken `export.pdb` using the healthy `exportLibrary.db` next to it, or from what survives in the file itself.

Run from source (macOS, Node 22 LTS, [pnpm](https://pnpm.io)):

```sh
pnpm install
pnpm dev
```

macOS only for now: drive detection and the format tools use `diskutil`. The repair engine itself (`src/engine`) is plain TypeScript and runs anywhere.

## Status

- Aligned output confirmed on 2 real XDJ-700s (firmware 1.15).
- Rebuilt full libraries (1293 tracks) load and play in emulation of the real XDJ-700 v1.15 and CDJ-2000NXS2 firmware, and open in desktop Rekordbox.
- A full rebuilt library has not been played on a real player yet. Reports welcome: open an issue with player model, firmware and what happened.

## Thanks

- [@0xphk](https://github.com/0xphk) for testing on two real XDJ-700s.
- [Deep Symmetry / crate-digger](https://github.com/Deep-Symmetry/crate-digger) and the PIONEER.md format docs.
- [M-Igashi/baken](https://github.com/M-Igashi/baken), [chrisle/rbxport](https://github.com/chrisle/rbxport), [haivala/dj-usb-tkit](https://github.com/haivala/dj-usb-tkit) for publishing their hardware findings.

## License

MIT
