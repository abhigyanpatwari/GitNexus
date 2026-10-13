struct Custom {
    var x: Int
    init(x: Int) { self.x = x }
}

struct Point {
    var x: Int
    var y: Int
}

func configure(x: Int) {}

let custom = Custom(x: 1)
let point = Point(x: 2, y: 3)
configure(x: 4)
