<?php
namespace App;

use function Ext\make;

function make(): int
{
    return 2;
}

// The qualified callee names `Lib\make`; neither the unresolved `use function Ext\make` nor the
// namespace's own `make` is what it means.
function qualified(): int
{
    return \Lib\make();
}

function control(): int
{
    return make();
}
