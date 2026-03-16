mod models;
use crate::models::Handler;

fn main() {
    let h = Handler { name: String::from("test") };
    h.process();
}
