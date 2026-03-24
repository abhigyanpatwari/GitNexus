mod point;
mod vec2;

use crate::point::Point;

fn process(p: Point) {
    let Point { x, y } = p;
    x.save();
    y.save();
}

fn main() {}
