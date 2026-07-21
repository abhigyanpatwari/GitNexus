module aptos_framework::object {
    friend aptos_framework::token;

    #[resource_group(scope = global)]
    struct ObjectGroup {}

    #[resource_group_member(group = aptos_framework::object::ObjectGroup)]
    struct ObjectCore has key {
        owner: address
    }

    public fun create(owner_signer: &signer, owner: address) {
        move_to(owner_signer, ObjectCore { owner });
    }

    #[view]
    public fun owner_of(addr: address): address acquires ObjectCore {
        let core = borrow_global<ObjectCore>(addr);
        core.owner
    }

    public(friend) fun transfer_ownership(
        addr: address, new_owner: address
    ) acquires ObjectCore {
        let core = borrow_global_mut<ObjectCore>(addr);
        core.owner = new_owner;
    }
}

module aptos_framework::token {
    friend aptos_framework::object;

    #[resource_group_member(group = aptos_framework::object::ObjectGroup)]
    struct Token has key, store {
        supply: u64
    }

    public fun mint(account: &signer, supply: u64) {
        move_to(account, Token { supply });
    }
}
