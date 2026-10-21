<?php

// Loaded through composer `autoload.files`, so no PSR-4 path names it.
namespace Qff\Mod;

function make(): QffWidget {
    return new QffWidget();
}

// No return type: nothing in the program says what a call returns.
function untyped() {
    return new QffWidget();
}
