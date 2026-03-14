use crate::serializable::Serializable;

pub struct User;

impl Serializable for User {
    fn serialize(&self) -> String {
        String::new()
    }
}
