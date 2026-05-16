<?php
namespace App\Services;

use App\Utils\Logger;

class Caller {
    public function callValidRecord(): void {
        Logger::record('info', 'started', 'processing', 'done');
    }

    public function callValidRecordMin(): void {
        Logger::record('info');
    }

    public function callTooFewRecord(): void {
        Logger::record();
    }

    public function callPureVariadic(): string {
        return Logger::format();
    }

    public function callPadMin(): string {
        return Logger::pad('x');
    }

    public function callPadTooFew(): string {
        return Logger::pad();
    }
}
