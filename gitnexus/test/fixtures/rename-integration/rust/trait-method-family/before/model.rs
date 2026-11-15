trait Work { fn compute(&self) -> i32; }
struct Worker {}
impl Work for Worker { fn compute(&self) -> i32 { 1 } }
struct Other {}
impl Other { fn compute(&self) -> i32 { 2 } }
fn dispatch(work: &dyn Work, worker: Worker, other: Other) -> i32 {
    work.compute() + worker.compute() + other.compute()
}
const LABEL: &str = "compute";
// compute on Other is not part of the trait implementation.
