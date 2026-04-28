pub trait Repository {
    fn find(&self, id: i32) -> String;
    fn save(&self, entity: &str) -> bool;
    fn count(&self) -> i32 { 0 }
}

pub struct SqlRepo;

impl Repository for SqlRepo {
    fn find(&self, id: i32) -> String { format!("user-{}", id) }
    fn save(&self, entity: &str) -> bool { true }
}
