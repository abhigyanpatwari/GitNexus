<?php
namespace App\Services;

function format_text(string $text): string {
    return strtoupper(trim($text));
}
