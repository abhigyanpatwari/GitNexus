<?php

namespace App\Services;

use App\Models\UserRepo;

class Mixed
{
    // Typed property: must emit exactly one Property def named `repo`,
    // zero stray Variable defs.
    private UserRepo $repo;

    // Untyped property: must emit exactly one (legitimate) catch-all def
    // for `$id`, and zero Property defs for it.
    public $id;

    // Constructor-promoted typed parameter: tree-sitter routes these
    // through the same `property_element` shape, so the dedup must also
    // suppress the stray Variable here.
    public function __construct(private UserRepo $promotedRepo)
    {
    }
}
