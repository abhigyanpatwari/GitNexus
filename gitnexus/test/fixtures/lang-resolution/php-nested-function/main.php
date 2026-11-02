<?php

function boot(): void {
    #[Deprecated]
    FUNCTION /* legal declaration trivia */ target(): void {}
}

$handler = function                              (): void {};

function caller(): void {
    boot();
    target();
}
