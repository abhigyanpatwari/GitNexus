<?php

namespace App\Services;

/**
 * Each method's receiver is an untyped parameter so the high-confidence
 * receiver-bound passes drop the site, leaving it for
 * phpEmitUnresolvedReceiverEdges (the 0.6-confidence fallback).
 *
 * The fallback's gate is EXACT-required-arity post-fix:
 *   - call argCount === fnDef.requiredParameterCount  → edge emitted
 *   - call argCount !== required, non-variadic         → NO edge (post-fix; pre-fix may have emitted)
 *   - variadic candidate, argCount >= required         → edge emitted
 *   - variadic candidate, argCount <  required         → NO edge
 */
class Caller
{
    public function callHappyPath($h): void
    {
        // happyPath(): min=0. argCount=0 → exact match. Edge.
        $h->happyPath();
    }

    public function callDefaultExactRequired($h): void
    {
        // withDefault($a, $b=0): min=1. argCount=1 === min → exact match. Edge.
        $h->withDefault('a');
    }

    public function callDefaultBeyondRequired($h): void
    {
        // withDefault($a, $b=0): min=1, max=2. argCount=2 > min.
        // Pre-fix: first-stage narrow accepts (2 <= 2), edge emitted.
        // Post-fix: exact-required gate rejects (2 !== 1), no edge.
        $h->withDefault('a', 99);
    }

    public function callVariadicAtRequired($h): void
    {
        // variadicLog($level, ...$args): min=1, hasVarArgs.
        // argCount=1 === min → edge emitted (variadic relaxed path).
        $h->variadicLog('info');
    }

    public function callVariadicBeyondRequired($h): void
    {
        // variadicLog($level, ...$args): min=1, hasVarArgs.
        // argCount=2 > min, variadic → edge emitted.
        $h->variadicLog('info', 'arg1');
    }

    public function callVariadicBelowRequired($h): void
    {
        // variadicLogTwoRequired($a, $b, ...$rest): min=2, hasVarArgs.
        // argCount=1 < min → no edge (first-stage rejects). Both pre/post-fix.
        $h->variadicLogTwoRequired('only-one');
    }
}
