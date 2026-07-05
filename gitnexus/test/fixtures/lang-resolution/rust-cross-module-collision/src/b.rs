use crate::traits::Drawable;

pub struct User {
    pub name: String,
}

impl Drawable for User {
    fn draw(&self) {}
}
