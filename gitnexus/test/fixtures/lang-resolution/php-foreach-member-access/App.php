<?php

require_once 'User.php';
require_once 'Repo.php';

class App {
    /** @var User[] */
    private array $users;

    public function __construct() {
        $this->users = [];
    }

    /**
     * $this->users member access in foreach — resolved via Phase 7.4 Strategy C:
     * scans the class body for the property_declaration and extracts the element
     * type from the @var PHPDoc annotation without requiring a @param workaround.
     */
    public function processMembers(): void {
        foreach ($this->users as $user) {
            $user->save();
        }
    }
}
