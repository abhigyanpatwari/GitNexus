<?php

namespace Qff\Mod;

class QffFactory {
    // Shares its name with the namespace function `Qff\Mod\make` but returns
    // the other class: a static call keeps naming the method.
    public static function make(): QffGadget {
        return new QffGadget();
    }
}
