module aptos_std::consumer {
    use aptos_std::math64;

    public fun compound(a: u64, b: u64, c: u64): u64 {
        let top = math64::max(a, b);
        let bot = math64::min(a, b);
        math64::clamp(c, bot, top)
    }
}
