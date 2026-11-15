package api

import (
	"github.com/gin-gonic/gin"

	"example.com/wrappedapp/service"
)

// API holds the console handlers.
type API struct{ svc *service.Jobs }

// CreateJob creates a job.
func (a *API) CreateJob(c *gin.Context) (interface{}, error) { return a.svc.Create(), nil }

// JobStatus reports a job's status.
func (a *API) JobStatus(c *gin.Context) (interface{}, error) { return nil, nil }

// UserInfo is a plain gin handler.
func UserInfo(c *gin.Context) {}
