use crate::traits::Drawable;

pub struct User {
    pub id: u32,
}

impl Drawable for User {
    fn draw(&self) {}
}
