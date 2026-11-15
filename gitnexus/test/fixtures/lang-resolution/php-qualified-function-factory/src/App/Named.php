<?php

namespace Qff\App;

// `make` lives in lib/functions.php (composer `autoload.files`), so no PSR-4
// path declares it: only its fully qualified name finds it.
use function Qff\Mod\make;

function namedCall(): int {
    $x = make();
    return $x->ping();
}
