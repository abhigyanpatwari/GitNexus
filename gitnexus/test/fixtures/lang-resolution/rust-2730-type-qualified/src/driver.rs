use crate::client::ClientBuilder;
use crate::client;

pub fn build() -> usize {
    ClientBuilder::new()
}

// Control: a genuine module qualifier must still resolve.
pub fn via_module() -> usize {
    client::new()
}
