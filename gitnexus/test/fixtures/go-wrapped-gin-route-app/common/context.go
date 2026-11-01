package common

import "github.com/gin-gonic/gin"

// HandlerFunc is the application handler shape the wrappers adapt.
type HandlerFunc func(c *gin.Context) (interface{}, error)

// Wrapper adapts an application handler to gin.
func Wrapper(handler HandlerFunc) func(c *gin.Context) {
	return WrapperWithSuccessCode(handler, "0")
}

// WrapperWithSuccessCode adapts a handler using the given success code.
func WrapperWithSuccessCode(handler HandlerFunc, code string) func(c *gin.Context) {
	return func(c *gin.Context) { _, _ = handler(c) }
}

// Auth is middleware, not a handler wrapper.
func Auth() func(c *gin.Context) { return func(c *gin.Context) {} }
