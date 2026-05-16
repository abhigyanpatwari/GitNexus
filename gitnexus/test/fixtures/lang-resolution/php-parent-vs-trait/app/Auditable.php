<?php
namespace App;

trait Auditable {
    public function record(): string {
        return 'trait';
    }
}
