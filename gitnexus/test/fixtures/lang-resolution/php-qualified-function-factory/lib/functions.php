<?php

// Loaded through composer `autoload.files`, so no PSR-4 path names it.
namespace Qff\Mod;

function make(): QffWidget {
    return new QffWidget();
}

// No return type annotation: the resolver should not infer the result from the body.
function untyped() {
    return new QffWidget();
}
