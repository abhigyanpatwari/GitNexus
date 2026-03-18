<?php

class Service {
    public function processUser(User $user): void {
        // 2-level chain: $user->address → Address, then ->save() → Address#save
        $user->address->save();

        // 3-level chain: $user->address → Address, ->city → City, ->getName() → City#getName
        $user->address->city->getName();
    }
}
