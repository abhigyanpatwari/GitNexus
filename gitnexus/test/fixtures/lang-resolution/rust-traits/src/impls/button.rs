use crate::traits::{Drawable, Clickable};

pub struct Button {
    label: String,
    enabled: bool,
}

impl Drawable for Button {
    fn draw(&self) {
        println!("{}", self.label);
    }

    fn resize(&self, width: u32, height: u32) {
    }
}

impl Clickable for Button {
    fn on_click(&self) {
        println!("clicked");
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }
}
