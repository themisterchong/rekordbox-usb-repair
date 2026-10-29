# Rekordbox USB Repair

**Your rekordbox USB library got corrupted?** rekordbox says "the device library is corrupted", the player shows no tracks or empty playlists, or the stick freezes on insert. Usually your music is still on the stick; only the library file (`export.pdb`) that lists the tracks and playlists is broken.

This tool rebuilds that file from whatever is still readable in it (the Mac app can also use the healthy `exportLibrary.db` next to it), keeping your tracks, playlists and their ids. Cues, beat grids and waveforms live in separate files on the stick and aren't touched. It never changes the original: the command line writes a new file, the app makes a verified backup before swapping. Nothing is written unless the rebuilt file reads back cleanly.

Tested on real corrupted libraries from GitHub issues (all tracks and playlists recovered, including from a truncated file another tool failed on) and on my own corrupted stick. Rebuilt libraries open in desktop rekordbox and load on real XDJ-700s.

Not affiliated with AlphaTheta or Pioneer DJ.

## Repair a corrupted library (macOS, Linux, Windows)

Needs only [Node.js](https://nodejs.org) 20 or newer. No install step.

```sh
git clone https://github.com/themisterchong/rekordbox-usb-repair
cd rekordbox-usb-repair
npx tsx cli/make-cdj-safe.ts /path/to/stick/PIONEER/rekordbox/export.pdb ~/export-fixed.pdb
```

It reads the damaged file page by page, keeps every track, playlist and playlist entry it can still read, and writes a clean new file with the original ids. It says what was damaged and what it recovered, checks the result (re-reads it, compares counts, re-checks string alignment) and writes nothing if anything is off. The input file is never touched.

Then:

1. Back up the stick's whole `PIONEER` folder (on a Mac-formatted stick it's `.PIONEER`).
2. Copy the fixed file onto the stick as `PIONEER/rekordbox/export.pdb`.
3. Eject properly and try it in the player.

If rekordbox asks to delete or reset the device library, say no until you've tried the repair: that deletes the file this tool recovers from.

## Other problems it fixes

**XDJ-700 freeze on insert = misaligned strings in `export.pdb`.** Every long text string (UTF-16 or long ASCII: titles, artists, albums, and so on) must start on a 4-byte boundary in the file. Rekordbox always writes them that way. Some third-party writers don't, and the XDJ-700 (firmware 1.15) then freezes on insert or at the "MY SETTINGS DATA was found" prompt. The CDJ-2000NXS2 freezes the same way ([baken#168](https://github.com/M-Igashi/baken/issues/168)). Confirmed on two real XDJ-700s with the [A/B test kit](testkit/) ([rbxport#483](https://github.com/chrisle/rbxport/issues/483)): aligned file loads, unaligned file freezes instantly.

**"FORMAT USB" on an XDJ-700 = wrong partition type, not missing files.** The player only mounts FAT partitions. An MBR partition with type `0x83` (Linux, `fdisk`'s default) shows FORMAT USB even with a valid export. Changing the type to `0x0c` (W95 FAT32 LBA) fixed it on real hardware. GPT-partitioned sticks show FORMAT USB in emulation of the real firmware too (not yet confirmed on hardware).

Fix the partition type on Linux:

```sh
sudo fdisk /dev/sdX      # t -> c -> w   (W95 FAT32 LBA)
sudo mkfs.vfat -F32 /dev/sdX1    # only if the partition isn't FAT32 yet - this erases it
```

The repair above also fixes the freeze: every rebuilt file has its strings aligned, so the same command makes a third-party export CDJ-safe. Verified: rebuilding the [test kit](testkit/)'s unaligned file B gives a file byte-identical to the aligned file A, which loads on real XDJ-700s.

## The Mac app

An Electron app that does the same thing with buttons, plus:

- **Health check** per stick: damaged / will freeze older players / missing files / safe.
- **Repair / make CDJ-safe**: the rebuild above, with backups and an atomic swap.
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

- Corrupted libraries: every readable track and playlist recovered from 3 corrupted `export.pdb` files posted in GitHub issues (496, 498 and 2163 tracks, one of them truncated) and from my own truncated stick (1085 tracks).
- Aligned output confirmed on 2 real XDJ-700s (firmware 1.15).
- Rebuilt full libraries (1293 tracks) load and play in emulation of the real XDJ-700 v1.15 and CDJ-2000NXS2 firmware, and open in desktop Rekordbox.
- An existing third-party export (rbxport) that froze a real XDJ-700 loads after running `make-cdj-safe`, no re-export needed ([rbxport#483](https://github.com/chrisle/rbxport/issues/483)).
- Reports from other players welcome: open an issue with player model, firmware and what happened.

## Thanks

- [@0xphk](https://github.com/0xphk) for testing on two real XDJ-700s.
- [Deep Symmetry / crate-digger](https://github.com/Deep-Symmetry/crate-digger) and the PIONEER.md format docs.
- [M-Igashi/baken](https://github.com/M-Igashi/baken), [chrisle/rbxport](https://github.com/chrisle/rbxport), [haivala/dj-usb-tkit](https://github.com/haivala/dj-usb-tkit) for publishing their hardware findings.

## Credit

Made by Mr. Chong ([themisterchong](https://github.com/themisterchong)). If this tool or what's in it helped your project, please credit Mr. Chong and link to this repository. Copying the code means keeping the copyright line from the MIT licence.

## License

MIT — Copyright (c) 2026 Mr. Chong (themisterchong). See [LICENSE](LICENSE).
