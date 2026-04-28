<?php
namespace App\Services;

function format_text_padded(string $text, int $width): string {
    return str_pad(strtoupper(trim($text)), $width);
}
