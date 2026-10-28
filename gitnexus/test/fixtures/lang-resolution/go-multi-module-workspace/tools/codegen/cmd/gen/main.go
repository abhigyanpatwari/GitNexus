package main

import "example.com/generator/v2/models"

func Generate(tpl *models.Template) string {
	return tpl.Render()
}
