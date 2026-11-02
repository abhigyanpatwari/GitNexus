extern "C" {
    fn compute(value: i32) -> i32;
}

pub fn call() -> i32 {
    unsafe { compute(1) }
}
