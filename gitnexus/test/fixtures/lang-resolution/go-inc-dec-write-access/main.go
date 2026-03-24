package main

type Counter struct {
	Count int
	Total int
}

func increment(c *Counter) {
	c.Count++
	c.Total++
}

func decrement(c *Counter) {
	c.Count--
}
