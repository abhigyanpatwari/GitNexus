<?php

namespace Services;

use Models\Child;

class App
{
    public function run(): void
    {
        $c = new Child();
        $c->parentMethod();
    }
}
