package legacy

// Same type and method name as models.Template, so a bare-name guess is
// ambiguous and only the import can pick models.
type Template struct{}

func (t *Template) Render() string { return "" }
