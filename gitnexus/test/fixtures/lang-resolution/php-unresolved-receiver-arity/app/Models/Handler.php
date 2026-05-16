<?php

namespace App\Models;

/**
 * Single workspace-unique candidate for each fallback-method name so the
 * unresolved-receiver fallback in phpEmitUnresolvedReceiverEdges fires
 * for untyped receivers. The names are deliberately chosen to NOT collide
 * with other fixtures so cross-fixture test interference cannot occur.
 *
 * Method-arity matrix:
 *   - happyPath():                                         min=0, max=0
 *   - withDefault(string $a, int $b = 0):                  min=1, max=2
 *   - variadicLog(string $level, ...$args):                min=1, max=undefined, hasVarArgs
 *   - variadicLogTwoRequired(string $a, string $b, ...$rest): min=2, max=undefined, hasVarArgs
 */
class Handler
{
    public function happyPath(): void {}

    public function withDefault(string $a, int $b = 0): void {}

    public function variadicLog(string $level, ...$args): void {}

    public function variadicLogTwoRequired(string $a, string $b, ...$rest): void {}
}
