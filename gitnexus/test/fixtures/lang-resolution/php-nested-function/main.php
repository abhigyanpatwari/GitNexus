<?php

function boot(): void {
    function target(): void {}
}

function caller(): void {
    boot();
    target();
}
