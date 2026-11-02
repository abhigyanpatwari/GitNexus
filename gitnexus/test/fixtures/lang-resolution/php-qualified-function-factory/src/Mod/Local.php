<?php

namespace Qff\Mod;

// `namespace\make` is the current namespace's `make`.
function relativeKeyword(): int {
    $x = namespace\make();
    return $x->ping();
}
