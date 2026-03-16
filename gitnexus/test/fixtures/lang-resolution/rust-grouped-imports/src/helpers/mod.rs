pub fn format_name(name: &str) -> String {
    format!("Hello, {}", name)
}

pub fn validate_email(email: &str) -> bool {
    email.contains('@')
}
