mod operations;
use operations::compute;

fn printed() { println!("{}", compute(1)); }
fn collected() -> Vec<i32> { vec![compute(2), operations::compute(3)] }
const LABEL: &str = "compute";
