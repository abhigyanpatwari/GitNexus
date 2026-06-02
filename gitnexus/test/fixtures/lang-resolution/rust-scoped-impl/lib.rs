pub mod outer {
    pub struct Inner;
}

impl outer::Inner {
    pub fn inner_method(&self) {}
}

pub trait Speak {
    fn speak(&self);
}

impl Speak for outer::Inner {
    fn speak(&self) {}
}
