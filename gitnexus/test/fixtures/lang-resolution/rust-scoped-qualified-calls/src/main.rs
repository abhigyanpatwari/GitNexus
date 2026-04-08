mod registry;

// No `use` imports — all calls use fully qualified paths
fn main() {
    // Scoped call: Type::method() without use import
    let reg = crate::registry::PeerRegistry::new();
    let _peers = reg.peers();

    // Scoped call: free function via qualified path
    let _interval = crate::registry::default_poll_interval();
}
