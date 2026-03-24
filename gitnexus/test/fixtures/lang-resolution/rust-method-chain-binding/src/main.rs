mod models;
use models::get_user;

fn process_chain() {
    let user = get_user();
    let addr = user.address;
    let city = addr.get_city();
    city.save();
}
