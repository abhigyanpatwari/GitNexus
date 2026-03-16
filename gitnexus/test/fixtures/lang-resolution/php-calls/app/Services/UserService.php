<?php

namespace App\Services;

use function App\Utils\OneArg\log;
use function App\Utils\ZeroArg\log as zero_log;

function create_user(): string
{
    return write_audit('hello');
}
