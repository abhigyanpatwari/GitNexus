<?php
// F54 — enum with cases
enum UserRole: string {
    case Admin = 'admin';
    case Editor = 'editor';
    case Viewer = 'viewer';
}

// F55 — anonymous class with method
$service = new class {
    public function execute(): void {
        echo "running";
    }
};
