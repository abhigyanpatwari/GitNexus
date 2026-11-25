mod operations;
use operations::calculate;

fn printed() { println!("{}", calculate(1)); }
fn collected() -> Vec<i32> { vec![calculate(2), operations::calculate(3)] }
const LABEL: &str = "compute";
