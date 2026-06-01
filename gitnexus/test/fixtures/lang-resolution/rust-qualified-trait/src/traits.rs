pub trait Drawable {
    fn draw(&self);
}

pub trait Wrapped<T> {
    fn wrap(&self) -> T;
}
