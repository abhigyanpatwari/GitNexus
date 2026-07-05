<?php

namespace App\Services;

/**
 * Exercises every dynamic PHP call/access shape that the tree-sitter
 * grammar should NOT capture as a resolvable reference. The negative
 * regression suite asserts zero CALLS edges from `Dynamic::*` to any
 * `Targets::*` method whose name only appears in dynamic position.
 *
 * Findings 1-7 of the adversarial review of PR #1497 confirmed via
 * grammar inspection that these patterns produce zero captures; this
 * fixture + test pair locks that invariant in regression coverage so
 * a future query.ts edit cannot silently break it.
 */
class Dynamic
{
    public function memberCallDynamicName(Targets $obj): void
    {
        // $obj->$method() — dynamic method name via variable_name node.
        // Query pattern requires `name: (name)` so this is not captured.
        $method = 'dynamicProcess';
        $obj->$method();
    }

    public function memberCallBraceDynamicName(Targets $obj): void
    {
        // $obj->{$method}() — brace-syntax variant of the above.
        $method = 'dynamicBrace';
        $obj->{$method}();
    }

    public function scopedCallDynamicMethodName(): void
    {
        // ClassName::$method() — dynamic method name on static dispatch.
        $method = 'dynamicHandle';
        Targets::$method();
    }

    public function scopedCallVariableClassNameStaticMethod($className): void
    {
        // $className::method() — class-name is an untyped parameter (no
        // type hint, no string-literal assignment that could be picked up
        // by a future type-binding heuristic). Receiver IS captured but
        // resolution falls through because $className has no class type
        // binding in scope. The unresolved-receiver fallback also doesn't
        // fire because `dynamicStaticMethod` is unique workspace-wide AND
        // exact-arity narrowing in U4 would still match — meaning the
        // ONLY thing keeping the edge count at zero today is the absence
        // of any type binding for the receiver.
        $className::dynamicStaticMethod();
    }

    public function scopedCallDynamicClassAndMethodName(): void
    {
        // $className::$method() — both dynamic.
        $className = 'App\\Services\\Targets';
        $method = 'dynamicScopedDynName';
        $className::$method();
    }

    public function callUserFuncVariableCallable($callable): void
    {
        // call_user_func($callable, ...) — resolver is structural-only
        // and never inspects argument values to infer the callable.
        // The literal `call_user_func` itself is an unresolved built-in.
        call_user_func($callable);
    }

    public function callUserFuncArrayVariable($callable, $args): void
    {
        // call_user_func_array($callable, $args) — unknown-arity variant.
        call_user_func_array($callable, $args);
    }

    public function callUserFuncStringCallable(): void
    {
        // 'Class::method' string-callable form — argument is a string
        // literal, never reaches the function: child of function_call_expression.
        call_user_func('App\\Services\\Targets::dynamicCallableMethod');
    }

    public function callUserFuncArrayObjectCallable(Targets $obj): void
    {
        // [$obj, 'method'] array-callable form — array is an argument
        // value, not the function: child.
        call_user_func([$obj, 'dynamicArrayCallableMethod']);
    }

    public function callUserFuncArrayClassNameCallable(): void
    {
        // ['Class', 'method'] array-callable with class-name string.
        call_user_func(['App\\Services\\Targets', 'dynamicArrayClassCallableMethod']);
    }

    public function dynamicPropertyRead(Targets $obj): string
    {
        // $obj->$prop — dynamic property read. No read-access property
        // capture pattern exists in query.ts at all (Finding 2).
        $prop = 'dynamicProp';
        return $obj->$prop;
    }

    public function sanityStaticCall(Targets $obj): void
    {
        // The fixture's deliberate sanity-check call. THIS one DOES emit
        // a CALLS edge — if the assertion that this edge exists ever
        // fails, the test infra is broken, not the dynamic-dispatch
        // suppression. Without this, every zero-edge assertion above
        // would pass even if the pipeline never emitted any edges at all.
        $obj->sanityStaticallyNamedTarget();
    }
}
