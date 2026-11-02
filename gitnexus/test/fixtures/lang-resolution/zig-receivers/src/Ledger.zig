// A file-struct with NO `const Self = @This();` alias: the only spelling of
// its type is the file stem, so the receiver rule needs the file path.
total: u64 = 0,
pub fn add(ledger: *Ledger, n: u64) void {
    ledger.total += n;
}
pub fn sum(ledger: Ledger) u64 {
    return ledger.total;
}
pub fn empty() Ledger {
    return .{};
}
