package router

import "github.com/gin-gonic/gin"

func (h *MatchHandler) UnfinalizeRoundHandle(c *gin.Context) {
	h.svc.UnfinalizeRound(c.Param("seasonId"), c.Param("roundId"))
	c.JSON(200, gin.H{"ok": true})
}
