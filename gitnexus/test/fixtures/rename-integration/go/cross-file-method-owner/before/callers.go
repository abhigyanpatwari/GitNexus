package model

func dispatch(work Work, worker *Worker, other Other) int {
    return work.Compute() + worker.Compute() + other.Compute(2)
}
const label = "Compute"
// Compute on Other has a different signature and does not implement Work.
