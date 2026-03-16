mod models;

use crate::models::User as U;
use crate::models::Repo as R;

fn main() {
    let u = U { name: String::from("alice") };
    let r = R { url: String::from("https://example.com") };
    u.save();
    r.persist();
}
