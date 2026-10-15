package owners

type Widget struct { Name string }
type Other struct {}

func (w *Widget) Describe() string { return w.Name }

func (*Widget) UnnamedPointerLocal() {}

func (Widget) UnnamedValueLocal() {}
