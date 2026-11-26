package handlers

import "github.com/gin-gonic/gin"

func RegisterRoutes(r *gin.Engine, svc *service.Service) {
	playerHandler := NewPlayerHandler(svc.Player)
	matchHandler := NewMatchHandler(svc.Match)
	r.GET("/ping", pingHandle)
	v1 := r.Group("/api/v1")
	{
		v1.GET("/health", func(c *gin.Context) { c.Status(200) })
		v1.GET("/players", playerHandler.GetPlayersHandle)
		v1.POST("/upload/avatar", UploadAvatarHandle)
		v1.GET("/exports", exports.ListExportsHandle)
		v1.PATCH("/players/:playerId", middleware.AuthRequired(svc.Auth), playerHandler.UpdatePlayerHandle)
		admin := v1.Group("/admin")
		admin.Use(middleware.AdminRequired(svc.AdminControl))
		{
			admin.POST("/seasons/:seasonId/rounds/:roundId/unfinalize", matchHandler.UnfinalizeRoundHandle)
			newsAdmin := admin.Group("/news")
			{
				newsAdmin.DELETE("/:id", newsHandler.DeleteNewsHandle)
			}
			knockoutAdmin := admin.Group("", middleware.KnockoutGuard())
			knockoutAdmin.POST("/seasons/:seasonId/knockout", knockoutHandler.CreateKnockoutHandle)
			adminOnly := admin.Group("")
			adminOnly.PUT("/seasons/:seasonId/streak-config", streakHandler.SaveStreakConfigHandle)
		}
	}
}
