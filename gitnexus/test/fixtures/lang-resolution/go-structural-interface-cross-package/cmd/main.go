package main

import (
	"github.com/example/gostruct/api"
	"github.com/example/gostruct/contracts"
	"github.com/example/gostruct/store"
)

func precise(user api.User) {
	var saver api.Saver = store.GoodStore{}
	saver.Save(user)
}

func fallback(saver api.Saver, user api.User) {
	saver.Save(user)
}

func fallbackReadCloser(rc contracts.ReadCloser) {
	rc.Close()
}
