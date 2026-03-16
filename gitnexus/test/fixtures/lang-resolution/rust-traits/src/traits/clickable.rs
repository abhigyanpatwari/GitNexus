pub trait Clickable {
    fn on_click(&self);
    fn is_enabled(&self) -> bool;
}
