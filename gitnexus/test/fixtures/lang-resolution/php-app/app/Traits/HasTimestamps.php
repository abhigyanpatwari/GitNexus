<?php

namespace App\Traits;

trait HasTimestamps
{
    protected string $status = 'active';

    public function touch(): void
    {
        $this->updatedAt = new \DateTimeImmutable();
    }
}
