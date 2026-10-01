package router

import "example.com/ginapp/service"

type MatchHandler struct {
	svc *service.Service
}

func NewMatchHandler(svc *service.Service) *MatchHandler {
	return &MatchHandler{svc: svc}
}
