<?php
namespace App\Services;

use App\Models\User;

// Two `User` classes exist in the workspace: App\Models\User and App\Other\User.
// The `use App\Models\User` import binds the simple name `User` to App\Models\User.
//
// The `save` method uses a fully-qualified type hint `\App\Other\User` — PHP
// runtime semantics: the leading backslash means "absolute namespace path",
// so this parameter is always App\Other\User, even though the simple `User`
// elsewhere in this file is App\Models\User.
//
// CALLS edges from `$u->record()` MUST resolve to app/Other/User.php::record,
// NOT app/Models/User.php::record. The `saveLocal` method exercises the
// simple-name path as a control — `User` here is the imported App\Models\User.
class Service {
    public function save(\App\Other\User $u): void {
        $u->record();
    }

    public function saveLocal(User $u): void {
        $u->record();
    }
}
