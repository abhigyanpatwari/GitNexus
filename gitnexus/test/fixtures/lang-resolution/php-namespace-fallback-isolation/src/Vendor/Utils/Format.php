<?php
namespace Vendor\Utils;

function format(string $s, int $width): string {
    return str_pad($s, $width);
}
