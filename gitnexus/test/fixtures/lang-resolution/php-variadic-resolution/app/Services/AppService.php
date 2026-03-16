<?php
namespace App\Services;

use App\Utils\Logger;

class AppService {
    public function run(): void {
        Logger::record("info", "started", "processing", "done");
    }
}
