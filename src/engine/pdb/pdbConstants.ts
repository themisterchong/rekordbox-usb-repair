/**
 * Ported from fragmede/rekordbox-pdb (MIT License, Copyright (c) 2026 fragmede)
 * https://github.com/fragmede/rekordbox-pdb - src/rekordbox_pdb/pdb.py
 * Verified byte-by-byte against real exports; see that repo's FORMAT.md.
 */

export const PAGE_HEADER_SIZE = 0x28
export const ROW_GROUP_SIZE = 0x24 // 16 u16 row offsets + u16 presence flags + u16 pad

export enum TableType {
  TRACKS = 0,
  GENRES = 1,
  ARTISTS = 2,
  ALBUMS = 3,
  LABELS = 4,
  KEYS = 5,
  COLORS = 6,
  PLAYLIST_TREE = 7,
  PLAYLIST_ENTRIES = 8,
  UNKNOWN_9 = 9,
  UNKNOWN_10 = 10,
  HISTORY_PLAYLISTS = 11,
  HISTORY_ENTRIES = 12,
  ARTWORK = 13,
  UNKNOWN_14 = 14,
  UNKNOWN_15 = 15,
  COLUMNS = 16,
  UNKNOWN_17 = 17,
  UNKNOWN_18 = 18,
  HISTORY = 19
}

/** Table types in exportExt.pdb (a different set from export.pdb). */
export enum ExtTableType {
  UNKNOWN_0 = 0,
  UNKNOWN_1 = 1,
  UNKNOWN_2 = 2,
  TAGS = 3, // My Tag categories and tags
  UNKNOWN_4 = 4,
  UNKNOWN_5 = 5,
  UNKNOWN_6 = 6,
  UNKNOWN_7 = 7,
  TAG_TRACKS = 8
}
