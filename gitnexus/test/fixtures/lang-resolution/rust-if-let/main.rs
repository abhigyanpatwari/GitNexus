mod models;
use models::{User, Config};

fn get_user() -> User {
    User { name: "alice".to_string(), age: 30 }
}

fn process_if_let() {
    // captured_pattern: user @ User { .. } — binds 'user' with type 'User'
    if let user @ User { .. } = get_user() {
        user.save();
    }
}

fn process_while_let() {
    // captured_pattern inside while-let
    while let cfg @ Config { .. } = get_config() {
        cfg.validate();
    }
}

fn get_config() -> Config {
    Config { debug: true }
}
