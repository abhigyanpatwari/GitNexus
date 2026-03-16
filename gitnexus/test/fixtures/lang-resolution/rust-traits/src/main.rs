mod traits;
mod impls;

use crate::impls::button::Button;

fn main() {
    let btn = Button { label: String::from("OK"), enabled: true };
}
