package contracts

import apix "github.com/example/gostruct/api"

type ReadCloser interface {
	apix.Reader
	Close() error
}
