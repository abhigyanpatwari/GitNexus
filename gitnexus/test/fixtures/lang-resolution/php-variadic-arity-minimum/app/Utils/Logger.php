<?php
namespace App\Utils;

class Logger {
    public static function record(string $level, string ...$messages): void {
        foreach ($messages as $msg) {
            echo "[$level] $msg\n";
        }
    }

    public static function format(...$parts): string {
        return implode('', array_map('strval', $parts));
    }

    public static function pad(string $s, int $w = 80, string ...$chars): string {
        $pad = empty($chars) ? ' ' : implode('', $chars);
        return str_pad($s, $w, $pad);
    }
}
