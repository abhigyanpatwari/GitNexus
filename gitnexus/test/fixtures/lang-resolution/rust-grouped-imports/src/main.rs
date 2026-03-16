mod helpers;

use crate::helpers::{format_name, validate_email};

fn main() {
    let name = format_name("world");
    let valid = validate_email("test@example.com");
    println!("{} {}", name, valid);
}
