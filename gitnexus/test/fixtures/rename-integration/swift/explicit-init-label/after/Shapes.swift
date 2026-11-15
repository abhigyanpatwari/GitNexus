struct Custom {
    var px: Int
    init(x: Int) { self.px = x }
}

struct Point {
    var x: Int
    var y: Int
}

func configure(x: Int) {}

let custom = Custom(x: 1)
let point = Point(x: 2, y: 3)
configure(x: 4)
