package impl

type File struct{}

func (f File) Read() error {
	return nil
}

func (f File) Close() error {
	return nil
}

type CloseOnly struct{}

func (c CloseOnly) Close() error {
	return nil
}
