//! Pieces of one object under commitment schema 3. The piece size is a pure
//! function of the object size, so a requester and a holder agree on every
//! byte offset without exchanging it.

use crate::commitment::commitment_piece_size;

/// At most this many pieces per object; the schema 3 piece size keeps every
/// object up to 16 MiB within it.
pub const MAX_PIECES: u32 = 64;

/// Pieces `start..end` (end exclusive) of one object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PieceRange {
    pub start: u32,
    pub end: u32,
}

/// The number of pieces in an object of `size` bytes, or `None` for an empty
/// object.
pub fn piece_count(size: u64) -> Option<u32> {
    if size == 0 || size > i64::MAX as u64 {
        return None;
    }
    let piece_size = commitment_piece_size(size as i64) as u64;
    u32::try_from(size.div_ceil(piece_size)).ok()
}

/// The byte offsets `[from, to)` of `range` within an object of `size` bytes,
/// or `None` when the range is empty or runs past the object's last piece.
pub fn range_bytes(size: u64, range: PieceRange) -> Option<(u64, u64)> {
    let count = piece_count(size)?;
    if range.start >= range.end || range.end > count || range.end > MAX_PIECES {
        return None;
    }
    let piece_size = commitment_piece_size(size as i64) as u64;
    let from = u64::from(range.start) * piece_size;
    let to = (u64::from(range.end) * piece_size).min(size);
    Some((from, to))
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn range(start: u32, end: u32) -> PieceRange {
        PieceRange { start, end }
    }

    #[test]
    fn piece_counts_stay_within_the_bound() {
        assert_eq!(piece_count(0), None);
        assert_eq!(piece_count(1), Some(1));
        assert_eq!(piece_count(65_536), Some(1));
        assert_eq!(piece_count(65_537), Some(2));
        assert_eq!(piece_count(4 * 1024 * 1024), Some(64));
        assert_eq!(piece_count(4 * 1024 * 1024 + 1), Some(52));
        assert_eq!(piece_count(16 * 1024 * 1024), Some(64));
        for size in (1..=16 * 1024 * 1024).step_by(4093) {
            assert!(piece_count(size).unwrap() <= MAX_PIECES, "size {size}");
        }
    }

    #[test]
    fn ranges_cover_the_object_exactly() {
        assert_eq!(range_bytes(200_000, range(0, 4)), Some((0, 200_000)));
        assert_eq!(range_bytes(200_000, range(1, 3)), Some((65_536, 196_608)));
        assert_eq!(range_bytes(200_000, range(3, 4)), Some((196_608, 200_000)));
        assert_eq!(range_bytes(200_000, range(3, 5)), None);
        assert_eq!(range_bytes(200_000, range(2, 2)), None);
        assert_eq!(range_bytes(200_000, range(3, 2)), None);
        assert_eq!(range_bytes(0, range(0, 1)), None);
    }
}
