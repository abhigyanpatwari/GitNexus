<?php

// `Qff\Dup\make` is declared twice (only one file would be loaded), so the
// analyzer cannot choose between them.
namespace Qff\Dup;

use Qff\Mod\QffWidget;

function make(): QffWidget {
    return new QffWidget();
}
