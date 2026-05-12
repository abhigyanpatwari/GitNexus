<?php
namespace App\Utils;

class Caller {
    public function callSameNamespace(): string {
        // Caller is in \App\Utils, calls `format('x')`. Same-namespace
        // resolution: emit edge to \App\Utils\format.
        return format('x');
    }
}
