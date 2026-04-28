mod lib;
use lib::{Dog, Animal};

fn main() {
    let dog = Dog::new();
    let sound = dog.speak();
    let toy = dog.fetch("ball");
}
