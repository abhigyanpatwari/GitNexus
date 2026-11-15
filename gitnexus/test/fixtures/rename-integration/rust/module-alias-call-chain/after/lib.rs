mod operations;
use operations::calculate as local_compute;

fn middle(value: i32) -> i32 { local_compute(value) }
fn outer(value: i32) -> i32 { middle(value) }
fn shadow(compute: i32) -> i32 { compute }
const LABEL: &str = "compute";
// compute is renamed at its import, while local_compute is stable.
