<?php

namespace App\Enums;

enum UserRole: string
{
    case Admin = 'admin';
    case Editor = 'editor';
    case Viewer = 'viewer';

    public function label(): string
    {
        return match($this) {
            self::Admin => 'Administrator',
            self::Editor => 'Editor',
            self::Viewer => 'Viewer',
        };
    }
}
