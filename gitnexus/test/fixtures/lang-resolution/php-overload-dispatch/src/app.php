<?php
namespace App;

use function App\Services\format_text;
use function App\Services\format_text_padded;

function run(): void {
    $plain = format_text("  hi  ");
    $padded = format_text_padded("hi", 20);
}
