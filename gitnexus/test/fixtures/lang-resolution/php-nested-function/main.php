<?php

function boot(): void {
    FUNCTION /* legal declaration trivia */ target(): void {}
}

function caller(): void {
    boot();
    target();
}
