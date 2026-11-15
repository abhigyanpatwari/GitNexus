package model

func dispatch(work Work, worker *Worker, other Other) int {
    return work.Calculate() + worker.Calculate() + other.Compute(2)
}
const label = "Compute"
// Compute on Other has a different signature and does not implement Work.
