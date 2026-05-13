<?php

namespace App\Services;

/**
 * Second attractor class. Its purpose is to provide a NON-UNIQUE
 * workspace-wide name for `dynamicStaticMethod`, so that the
 * phpEmitUnresolvedReceiverEdges 0.6-confidence fallback cannot fire
 * for the `$className::dynamicStaticMethod()` site in Dynamic.php.
 * That isolates the dynamic-receiver test from the U4 concern
 * (Finding 8 — unresolved-receiver fallback tightening).
 */
class OtherTargets
{
    public static function dynamicStaticMethod(): void {}
}
