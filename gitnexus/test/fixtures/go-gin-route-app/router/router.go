package router

import (
	"github.com/gin-gonic/gin"

	"example.com/ginapp/handlers"
	"example.com/ginapp/service"
)

func RegisterRoutes(r *gin.Engine, svc *service.Service) {
	matchHandler := NewMatchHandler(svc)
	auth := &AuthHandler{}
	var anyAuth Authenticator = auth
	v1 := r.Group("/api/v1")
	{
		admin := v1.Group("/admin")
		admin.POST("/seasons/:seasonId/rounds/:roundId/unfinalize", matchHandler.UnfinalizeRoundHandle)
		admin.POST("/login", anyAuth.Login)
	}
	v1.POST("/login", auth.Login)
	v1.GET("/health", handlers.Health)
	v1.GET("/version", Version)
	v1.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })
	registerLegacy(v1)
}

// Groups handed to another function are out of scope: no route below.
func registerLegacy(g *gin.RouterGroup) {
	g.GET("/legacy", Version)
}

func Version(c *gin.Context) {
	c.String(200, "1")
}
