pub trait Drawable {
    fn draw(&self);
    fn resize(&self, width: u32, height: u32);
}
