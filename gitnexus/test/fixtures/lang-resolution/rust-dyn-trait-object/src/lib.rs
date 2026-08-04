pub trait Behaviour {
    fn trait_target(&self) -> u32;
}

pub struct Impl1;

impl Behaviour for Impl1 {
    fn trait_target(&self) -> u32 {
        7
    }
}

pub fn calls_via_dyn(b: &dyn Behaviour) -> u32 {
    b.trait_target()
}
