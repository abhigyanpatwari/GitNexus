package model

func (worker *Worker) Compute() int { return 1 }
func (other Other) Compute(value int) int { return value }
