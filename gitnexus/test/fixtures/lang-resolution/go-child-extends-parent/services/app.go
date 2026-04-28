package services

import "example.com/app/models"

func Run() {
	c := &models.Child{}
	c.ParentMethod()
}
