package status

import "github.com/gin-gonic/gin"

func Status(c *gin.Context) {
	c.String(200, "ok")
}
