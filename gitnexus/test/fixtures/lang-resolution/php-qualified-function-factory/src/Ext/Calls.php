<?php

namespace Qff\Ext;

// None of these callees names exactly one workspace function: a PHP builtin,
// a vendor package that is not installed, and a name declared twice. The
// same-named `count` and `make` in Shadows.php are not the functions called.
function builtinCall(array $items): int {
    return \count($items);
}

function vendorCall(): int {
    $x = \Vendor\Pkg\make();
    return $x->ping();
}

function ambiguousCall(): int {
    $x = \Qff\Dup\make();
    return $x->ping();
}
