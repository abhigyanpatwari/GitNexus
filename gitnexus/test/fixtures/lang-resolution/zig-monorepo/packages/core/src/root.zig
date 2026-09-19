pub const DEFAULT_RETRIES: u8 = 3;

pub fn retryBudget(attempt: u8) u8 {
    return DEFAULT_RETRIES - attempt;
}

pub const Config = struct {
    retries: u8 = DEFAULT_RETRIES,

    pub fn load(self: *Config) u8 {
        return self.retries;
    }
};
