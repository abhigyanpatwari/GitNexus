mod onearg;
mod zeroarg;

use crate::onearg::write_audit;
use crate::zeroarg::write_audit as zero_write_audit;

fn main() {
    let _ = write_audit("hello");
}
