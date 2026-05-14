<?php

namespace App\Models;

class ChildModel extends ParentModel
{
    public function method(int $a, int $b): bool { return true; }

    public function compat(int $a): bool { return true; }
}
