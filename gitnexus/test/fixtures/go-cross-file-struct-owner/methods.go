package owners

func (w *Widget) Rename(n string) { w.Name = n }
func (w Widget) Clone() Widget { return w }
func (w *Widget) Run() {}
func (o *Other) Run() {}

func (*Widget) UnnamedPointer() {}

func (Widget) UnnamedValue() {}
