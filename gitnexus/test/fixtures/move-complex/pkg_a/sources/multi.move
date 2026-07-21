// module 0xBAD::commented {}
module app::vault {
    use oracle::price::get;

    #[view]
    public fun price(): u64 {
        get()
    }
}

module app::shared {
    public fun ping(): u64 {
        1
    }
}
