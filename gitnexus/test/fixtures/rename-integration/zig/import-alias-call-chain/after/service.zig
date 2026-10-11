pub fn calculate(value: u8) u8 { return value; }
pub fn middle(value: u8) u8 { return calculate(value); }
pub fn entry(value: u8) u8 { return middle(value); }
// process is a public API; this comment is not a reference.
