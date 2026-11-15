<?php

// A same-named function in another namespace. No caller names it.
namespace Qff\Decoy;

use Qff\Mod\QffGadget;

function make(): QffGadget {
    return new QffGadget();
}
