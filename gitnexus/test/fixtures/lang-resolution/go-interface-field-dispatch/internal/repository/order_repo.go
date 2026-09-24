package repository

type OrderRepo struct {
	dsn string
}

func (r *OrderRepo) DeleteItem(id string) error { return nil }

func (r *OrderRepo) GetPickQueue(id string) ([]string, error) { return nil, nil }

func (r *OrderRepo) UnsplitOrder(id string) error { return nil }
