<?php

function boot(): void {
    FUNCTION target(): void {}
}

function caller(): void {
    boot();
    target();
}
