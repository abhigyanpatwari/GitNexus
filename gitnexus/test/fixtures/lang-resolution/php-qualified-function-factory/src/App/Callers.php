<?php

namespace Qff\App;

use Qff\Mod as rp;
use Qff\Mod\QffFactory;

// `rp\make` and `\Qff\Mod\make` both name `Qff\Mod\make`, declared `: QffWidget`.
function aliasCall(): int {
    $x = rp\make();
    return $x->ping();
}

function inlineAlias(): int {
    return rp\make()->ping();
}

function fullyQualified(): int {
    $x = \Qff\Mod\make();
    return $x->ping();
}

function inlineFullyQualified(): int {
    return \Qff\Mod\make()->ping();
}

function staticControl(): int {
    $x = QffFactory::make();
    return $x->ping();
}

function untypedAlias(): int {
    $x = rp\untyped();
    return $x->ping();
}

function untypedInline(): int {
    return rp\untyped()->ping();
}
