mod utils;
use utils::save;

// Local function shadows imported save
fn save(data: &str) {
    println!("local save: {}", data);
}

fn run() {
    save("test");
}

fn main() {
    run();
}
