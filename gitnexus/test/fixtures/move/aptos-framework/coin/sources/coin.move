module aptos_framework::coin {
    friend aptos_framework::coin_admin;

    /// A generic coin balance held under an account.
    struct CoinStore<phantom CoinType> has key {
        balance: u64
    }

    #[event]
    struct TransferEvent has drop, store {
        from: address,
        to: address,
        amount: u64
    }

    const E_NOT_REGISTERED: u64 = 1;
    const E_INSUFFICIENT_BALANCE: u64 = 2;

    public entry fun register<CoinType>(account: &signer) {
        move_to(account, CoinStore<CoinType> { balance: 0 });
    }

    public entry fun transfer<CoinType>(
        from: address, to: address, amount: u64
    ) acquires CoinStore {
        let from_store = borrow_global_mut<CoinStore<CoinType>>(from);
        assert!(from_store.balance >= amount, E_INSUFFICIENT_BALANCE);
        from_store.balance = from_store.balance - amount;
        let to_store = borrow_global_mut<CoinStore<CoinType>>(to);
        to_store.balance = to_store.balance + amount;
    }

    #[view]
    public fun balance_of<CoinType>(addr: address): u64 acquires CoinStore {
        let store = borrow_global<CoinStore<CoinType>>(addr);
        store.balance
    }

    public(friend) fun mint_internal<CoinType>(to: address, amount: u64) acquires CoinStore {
        let store = borrow_global_mut<CoinStore<CoinType>>(to);
        store.balance = store.balance + amount;
    }

    public(friend) fun burn_internal<CoinType>(
        from: address
    ): CoinStore<CoinType> acquires CoinStore {
        move_from<CoinStore<CoinType>>(from)
    }
}

module aptos_framework::coin_admin {
    public fun mint<CoinType>(to: address, amount: u64) {
        aptos_framework::coin::mint_internal<CoinType>(to, amount);
    }
}
