package service

// Jobs is the job service.
type Jobs struct{}

// Create creates a job.
func (j *Jobs) Create() string { return "job" }
