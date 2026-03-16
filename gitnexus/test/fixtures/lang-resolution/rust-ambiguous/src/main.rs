mod models;
mod other;
mod services;

fn main() {
    let h = services::create_handler();
    h.handle();
}
