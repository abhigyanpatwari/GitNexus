<?php
namespace App\Utils;

class Logger {
    public static function record(string $level, string ...$messages): void {
        foreach ($messages as $msg) {
            echo "[$level] $msg\n";
        }
    }
}
