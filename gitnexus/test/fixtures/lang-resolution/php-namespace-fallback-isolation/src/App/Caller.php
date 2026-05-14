<?php
namespace App;

use function Vendor\Utils\format as vendorFormat;

class Caller {
    public function callNoImport(): string {
        // No use function for `format`. Caller is in \App, candidates live
        // in \App\Utils and \Vendor\Utils. PHP runtime: Call to undefined
        // function App\format. Resolver must emit NO edge.
        return format('x');
    }

    public function callImported(): string {
        // Imported via `use function Vendor\Utils\format as vendorFormat`.
        // Resolver must emit an edge to Vendor\Utils\format.
        return vendorFormat('x', 80);
    }
}
