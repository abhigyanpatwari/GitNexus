<?php

namespace Qff;

// A qualified name without a leading `\` is relative to the current namespace.
function namespaceRelative(): int {
    $x = Mod\make();
    return $x->ping();
}
