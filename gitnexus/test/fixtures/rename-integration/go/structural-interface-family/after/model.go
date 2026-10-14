package model

type Work interface { Calculate() int }
type Worker struct {}
func (worker Worker) Calculate() int { return 1 }
type Other struct {}
func (other Other) Compute(value int) int { return value }
func dispatch(work Work, worker Worker, other Other) int {
    return work.Calculate() + worker.Calculate() + other.Compute(2)
}
const label = "Compute"
// Compute on Other has a different signature and does not implement Work.
