<?php

// PHP CFG hazard fixture for the PDG layer — one construct per function, with
// distinctive call text so a test can locate the block for a region. Mirrors the
// other languages' cfg hazard fixtures (java-hazards / python-hazards).

namespace App\Cfg;

function ifElifElse(int $x): void
{
    if ($x > 0) {
        positive();
    } elseif ($x < 0) {
        negative();
    } else {
        zero();
    }
    after();
}

function loops(array $arr, int $n): void
{
    for ($i = 0; $i < $n; $i++) {
        forBody();
    }
    foreach ($arr as $v) {
        eachValue($v);
    }
    foreach ($arr as $k => $v) {
        eachPair($k, $v);
    }
    while ($n > 0) {
        whileBody();
        $n--;
    }
    do {
        doBody();
    } while ($n < 10);
}

function switchFallthrough(int $x): string
{
    switch ($x) {
        case 1:
            one();
            break;
        case 2:
            two();
            // falls through (no break)
        case 3:
            three();
            break;
        default:
            other();
    }
    return done();
}

function matchValue(int $x): string
{
    $r = match ($x) {
        1, 2 => "low",
        3 => "mid",
        default => "high",
    };
    return $r;
}

function tryCatchFinally(): void
{
    try {
        risky();
    } catch (\TypeError | \ValueError $e) {
        handleTyped($e);
    } catch (\Exception $ex) {
        handleOther($ex);
    } finally {
        cleanup();
    }
    afterTry();
}

function breakTwo(): void
{
    while (true) {
        for ($i = 0; ; $i++) {
            if (cond()) {
                break 2;
            }
            if (other()) {
                continue 2;
            }
            innerBody();
        }
        unreachableAfterInner();
    }
    afterLoops();
}

function infiniteLoop(int $x): void
{
    while (true) {
        if ($x) {
            tick();
        }
    }
}

function returnThroughFinally(int $x): int
{
    try {
        if ($x > 0) {
            return earlyReturn();
        }
        body();
    } finally {
        releaseLock();
    }
    return fallReturn();
}

function defsAndUses(array $data): int
{
    $x = $data;
    $y = transform($x);
    [$a, $b] = split($y);
    list($c, $d) = pair($a);
    return $b + $c + $d;
}

function closureCapture(int $b): callable
{
    $c = make();
    return function (int $a) use ($b, &$c) {
        return $a + $b + $c;
    };
}

function arrowFn(int $n): callable
{
    return fn(int $a) => $a * $n;
}
