# XDJ-700 freeze test kit (UTF-16 string alignment)

The A/B test that showed, on **real hardware**, what freezes a Pioneer XDJ-700 (firmware v1.15) when it reads a
rekordbox USB export (`export.pdb`).

Both files hold the same **anonymised** 1,293-track library: every name, title, comment and file path is random text,
and there is no audio. They are identical except for **one thing**:

| file | long/UTF-16 strings | on XDJ-700 v1.15 |
|---|---|---|
| `export-A-aligned.pdb` | start on a 4-byte boundary (as rekordbox writes them) | **works**: loads and browses all menus |
| `export-B-unaligned.pdb` | some start at unaligned offsets | **freezes** instantly on insert (or at "MY SETTINGS DATA was found" if the stick has My Settings files) |

Confirmed on two real XDJ-700s (firmware 1.15) by [@0xphk](https://github.com/0xphk) in
[chrisle/rbxport#483](https://github.com/chrisle/rbxport/issues/483). The same result shows up in emulation of the real
firmware: my own XDJ-700 v1.15 emulator, and
[Stijn-Jacobs/cdj-nxs2-qemu](https://github.com/Stijn-Jacobs/cdj-nxs2-qemu) on the XDJ-700 and CDJ-2000NXS2.

SHA-256:
```
66e8d84b9229a7cdb598dea0e87868d81b95da4949048dc73fa8bb77456e4b63  export-A-aligned.pdb
9701f5f1f386275cb12eb6164749376d2266b73b7aab3767588667ae126a8cb2  export-B-unaligned.pdb
```

## Check the repair tool yourself

Rebuilding B with the repair tool gives a file byte-identical to A:

```sh
npx tsx cli/make-cdj-safe.ts testkit/export-B-unaligned.pdb /tmp/B-fixed.pdb
cmp /tmp/B-fixed.pdb testkit/export-A-aligned.pdb && echo identical
```

## Test it on your own player

1. Use a **spare** USB stick (FAT32, MBR partition type `0x0c`). Don't use your gig stick, or back it up first.
2. Create the folder `PIONEER/rekordbox/` on the stick.
3. Copy **file A** into it and rename it to `export.pdb`.
4. Insert the stick into the player, tap **USB** and open **BROWSE → ARTIST**. Note what happens.
5. Repeat with **file B**. If it freezes, power-cycle the player.

Tracks show up in the browser but won't play, because the kit contains no music. That's expected; only the mounting
and browsing matter here.

Results on other players (CDJ-900, CDJ-2000, XDJ-RX, ...) are very welcome:
[open an issue](https://github.com/themisterchong/rekordbox-usb-repair/issues) with player model, firmware version, and
what A and B did. "Both worked" is just as useful as a freeze.

## What differs

B is A with the strings misaligned: artist names at `0x0a` instead of `0x0c`, album names at `0x16` instead of `0x18`,
and track-row strings without padding. The same class of bug froze a CDJ-2000NXS2 in
[M-Igashi/baken#168](https://github.com/M-Igashi/baken/issues/168).

**Fix for exporters:** every long-ASCII (`0x40`) and UTF-16 (`0x90`) DeviceSQL string must start on a 4-byte
boundary. That means rows start 4-aligned in the page heap, artist names at `0x0c`, album names at `0x18`, and track
strings padded to a 4-byte boundary within the row.
