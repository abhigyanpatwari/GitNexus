package echoapp

import "github.com/labstack/echo/v4"

type UserHandler struct{}

func (u *UserHandler) List(c echo.Context) error { return nil }

func authMW(next echo.HandlerFunc) echo.HandlerFunc { return next }

func Setup() *echo.Echo {
	e := echo.New()
	h := &UserHandler{}
	api := e.Group("/echo")
	api.GET("/users", h.List, authMW)
	return e
}
