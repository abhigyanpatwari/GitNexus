package routes

import (
	consoleApi "example.com/wrappedapp/api"
	"example.com/wrappedapp/common"
	core "example.com/infra/pkg"
)

// InitRoute registers every route on the wrapper package's engine alias.
func InitRoute(s *core.Engine, api *consoleApi.API) {
	v1 := s.Group("/console/v1")
	{
		jobs := v1.Group("/jobs")
		jobs.POST("/create", common.Wrapper(api.CreateJob))
		jobs.GET("/status", common.Auth(), common.WrapperWithSuccessCode(api.JobStatus, "OK"))
		jobs.GET("/userinfo", consoleApi.UserInfo)
	}
}
