package api

type Service struct{}

func NewService() *Service { return &Service{} }

func (service *Service) Run(value int) int { return value + 1 }
