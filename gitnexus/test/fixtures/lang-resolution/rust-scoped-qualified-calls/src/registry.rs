pub struct PeerRegistry {
    peers: Vec<String>,
}

impl PeerRegistry {
    pub fn new() -> Self {
        PeerRegistry { peers: vec![] }
    }

    pub fn peers(&self) -> &[String] {
        &self.peers
    }
}

pub fn default_poll_interval() -> u64 {
    30
}
