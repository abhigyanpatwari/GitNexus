<?php

namespace App\Services;

/**
 * Attractors: every method name here is unique workspace-wide so that if
 * the dynamic-dispatch suppression in the query / resolver layer ever
 * regresses, the false-positive CALLS edges would surface against these
 * targets.
 */
class Targets
{
    public function dynamicProcess(): void {}

    public function dynamicHandle(): void {}

    public function dynamicBrace(): void {}

    public static function dynamicStaticMethod(): void {}

    public static function dynamicScopedDynName(): void {}

    public function dynamicCallableMethod(): void {}

    public function dynamicArrayCallableMethod(): void {}

    public function dynamicArrayClassCallableMethod(): void {}

    public string $dynamicProp = '';

    /**
     * Sanity-check target: the fixture's one non-dynamic call DOES reach
     * this method, proving the test infra emits CALLS edges normally.
     */
    public function sanityStaticallyNamedTarget(): void {}
}
