package router

import "github.com/gin-gonic/gin"

type Authenticator interface {
	Login(c *gin.Context)
}

type AuthHandler struct{}

func (a *AuthHandler) Login(c *gin.Context) {}

type AdminAuthHandler struct{}

func (a *AdminAuthHandler) Login(c *gin.Context) {}
