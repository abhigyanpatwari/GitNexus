<?php

namespace App\Traits;

trait SoftDeletes
{
    protected string $status = 'active';

    public function softDelete(): void
    {
        $this->deletedAt = new \DateTimeImmutable();
    }

    public function restore(): void
    {
        $this->deletedAt = null;
    }
}
