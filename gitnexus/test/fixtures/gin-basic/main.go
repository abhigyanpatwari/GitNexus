package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	r.GET("/users", listUsers)
	r.POST("/users", createUser)
	router := gin.New()
	router.DELETE("/users/:id", deleteUser)
	engine := gin.New()
	engine.PATCH("/users/:id", updateUser)
	r.PUT("/users/:id", replaceUser)
}

func listUsers(c *gin.Context)  {}
func createUser(c *gin.Context) {}
func deleteUser(c *gin.Context) {}
func updateUser(c *gin.Context) {}
func replaceUser(c *gin.Context) {}
