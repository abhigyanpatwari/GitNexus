<?php

class Service {
    public function processUser(User $user): void {
        // Field-access chain: $user->address → Address, then ->save() → Address#save
        $user->address->save();
    }
}
