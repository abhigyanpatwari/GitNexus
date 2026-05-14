<?php

namespace App\Services;

use function App\Utils\OneArg\write_audit;
use function App\Utils\ZeroArg\write_audit as zero_write_audit;

function create_user(): string
{
    // Two visible write_audit candidates (different arities). Arity narrowing
    // must pick the 1-arg OneArg version. This validates that visibility +
    // arity together correctly disambiguate.
    return write_audit('hello');
}
